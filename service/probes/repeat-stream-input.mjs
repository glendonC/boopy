/** Explicit fictional-only diagnostic. Importing this file never runs a provider. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareEvidence } from '../src/evidence.ts';
import { OllamaInterpreter } from '../src/interpret/ollama.ts';
import { nearest, VisionTextReader } from '../src/ocr.ts';
import { WhisperEngine } from '../src/speech.ts';
import { MacSayOutput } from '../src/speech-output.ts';
import { frameOf } from '../src/testing.ts';

const fingerprint = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const metricNames = [
  'total_duration',
  'load_duration',
  'prompt_eval_count',
  'prompt_eval_cached_count',
  'prompt_eval_duration',
  'eval_count',
  'eval_duration',
];

/** One fresh in-memory manufactured input. */
export async function manufactureInput() {
  const frame = frameOf();
  const image = Buffer.from(frame.jpeg, 'base64');
  const speech = join(homedir(), '.halcyonic/speech');
  const wav = await new MacSayOutput({ timeoutMs: 10000 }).synthesize(
    'What do you see in this fictional desert picture? Answer in one short sentence.',
    'en',
  );
  try {
    const heard = await new WhisperEngine({
      binary: join(speech, 'whisper.cpp-1.9.4/bin/whisper-cli'),
      model: join(speech, 'models/ggml-large-v3-turbo-q5_0.bin'),
      vadModel: join(speech, 'models/ggml-silero-v6.2.0.bin'),
    }).transcribe(wav.wav);
    if (!heard.text.trim()) throw new Error('Synthetic input unavailable.');
    const [lines, evidence] = await Promise.all([
      new VisionTextReader(new URL('../.build/boopy-ocr', import.meta.url).pathname).read(image),
      prepareEvidence(image, { gaze: null, pointer: null }),
    ]);
    return {
      inputSource: 'speech',
      conversation: [],
      contextualItems: [],
      said: heard.text,
      language: heard.language,
      scope: 'auto',
      gaze: null,
      pointer: null,
      image: evidence.marked,
      crop: evidence.crop,
      text: nearest(lines, 0.5, 0.5, 40),
      decisions: [],
      sourceContext: {
        source: 'unknown',
        capturedAt: frame.capturedAt,
        timestampTrusted: false,
        selectionReason: 'Legacy selected view; current scene/time not established.',
      },
    };
  } finally {
    // MacSay and Whisper own/remove their temporary files in their own finally blocks.
    // Only this manufactured audio buffer lives here; no journal/service is constructed.
    wav.wav.fill(0);
  }
}

/** Exactly three validations through one adapter; emits no question, OCR, answer or raw output. */
export async function repeatInput(
  input,
  interpreter,
  emit = (value) => console.log(JSON.stringify(value)),
) {
  const sha256 = fingerprint(input);
  const actualFetch = globalThis.fetch;
  let calls = [];
  let allSchemaValid = true;
  globalThis.fetch = async (...args) => {
    const started = performance.now();
    const body = typeof args[1]?.body === 'string' ? JSON.parse(args[1].body) : {};
    const metadata = { wallMs: 0, status: 0, schemaFormat: body.format !== undefined };
    try {
      const response = await actualFetch(...args);
      metadata.status = response.status;
      let value;
      try {
        value = await response.clone().json();
      } catch {
        /* Never retain response diagnostics. */
      }
      for (const name of metricNames)
        if (typeof value?.[name] === 'number' && Number.isFinite(value[name]) && value[name] >= 0)
          metadata[name] = value[name];
      return response;
    } finally {
      metadata.wallMs = Math.round(performance.now() - started);
      calls.push(metadata);
    }
  };
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (fingerprint(input) !== sha256) throw new Error('Synthetic input changed.');
      calls = [];
      const started = performance.now();
      let schemaValid = false;
      try {
        await interpreter.interpret(input);
        schemaValid = true;
      } catch {
        /* Attempt outcome only; no model text or exception content. */
      }
      if (fingerprint(input) !== sha256) throw new Error('Synthetic input changed.');
      allSchemaValid = allSchemaValid && schemaValid;
      emit({
        attempt,
        wallMs: Math.round(performance.now() - started),
        inputSha256: sha256,
        schemaValid,
        calls,
      });
    }
    return allSchemaValid;
  } finally {
    globalThis.fetch = actualFetch;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = await manufactureInput();
    const allSchemaValid = await repeatInput(
      input,
      new OllamaInterpreter({
        url: 'http://127.0.0.1:11434',
        model: 'qwen3.6:35b-a3b-nvfp4',
        timeoutMs: 55000,
        think: false,
      }),
    );
    if (!allSchemaValid) process.exitCode = 1;
  } catch {
    console.error('Fictional repeat diagnostic unavailable; no content retained.');
    process.exitCode = 1;
  }
}
