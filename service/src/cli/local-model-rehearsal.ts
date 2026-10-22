/** Real local adapters, entirely synthetic sources and isolated in-memory storage. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Boopy } from '../boopy.ts';
import { SessionView } from '../contracts.ts';
import { evidenceRecords } from '../evidence-contract.ts';
import { connectorApp } from '../http/connector.ts';
import { headsetApp } from '../http/headset.ts';
import { OllamaInterpreter } from '../interpret/ollama.ts';
import { VisionTextReader } from '../ocr.ts';
import { WhisperEngine } from '../speech.ts';
import { QwenSpeechOutput } from '../speech-output/qwen.ts';
import { MacSayOutput } from '../speech-output.ts';
import { frameOf, testBoopy } from '../testing.ts';

const run = promisify(execFile);
const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceWords =
  'What is the Korean word for desert in this note, and what could I ask next about the note?';
const personalDetail = 'For this synthetic example, I wrote this note yesterday.';
// Controlled mappings read from the repository's synthetic note, not model-generated answers.
const translations = [
  ['I rode a camel', '낙타를 탔어요'],
  ['It was very quiet', '아주 조용했어요'],
  ['I went to Morocco', '모로코에 갔어요'],
  ['camel', '낙타'],
  ['desert', '사막'],
] as const;
function verifyFollowupTranslation(question: string, answer: string): boolean | null {
  if (!/in Korean|Korean (?:for|word)|translate.*Korean/i.test(question)) return null;
  const mapping = translations.find(([english]) =>
    question.toLowerCase().includes(english.toLowerCase()),
  );
  return mapping === undefined ? null : answer.includes(mapping[1]);
}

export function rehearsalSpeechOptions(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.BOOPY_SPEECH_OUTPUT ?? 'mac-say';
  if (provider === 'mac-say') return { provider } as const;
  if (provider !== 'qwen' || !env.BOOPY_VOICE_PYTHON || !env.BOOPY_VOICE_MODEL)
    throw new Error(
      'Select mac-say or qwen with explicit BOOPY_VOICE_PYTHON and BOOPY_VOICE_MODEL.',
    );
  return {
    provider,
    python: env.BOOPY_VOICE_PYTHON,
    modelDirectory: env.BOOPY_VOICE_MODEL,
  } as const;
}

export async function localModelRehearsal(
  options: {
    reviewSynthetic?: (turn: { question: string; answer: string }) => void;
    speechOutput?: ReturnType<typeof rehearsalSpeechOptions>;
  } = {},
) {
  const started = performance.now();
  const timings: Record<string, number> = {};
  const diagnostic: {
    transcript?: string;
    firstAnswer?: string;
    question?: string;
    followupAnswer?: string;
  } = {};
  let phase = 'initialize';
  const speechOptions = options.speechOutput ?? rehearsalSpeechOptions();
  const neural = speechOptions.provider === 'qwen' ? new QwenSpeechOutput(speechOptions) : null;
  const test = testBoopy();
  const say = new MacSayOutput({ timeoutMs: 10000 });
  const boopy = new Boopy({
    ...test.deps,
    interpreter: new OllamaInterpreter({
      url: 'http://127.0.0.1:11434',
      model: 'qwen3.6:35b-a3b-nvfp4',
      timeoutMs: 55000,
      think: false,
    }),
    speech: new WhisperEngine({
      binary: join(homedir(), '.halcyonic/speech/whisper.cpp-1.9.4/bin/whisper-cli'),
      model: join(homedir(), '.halcyonic/speech/models/ggml-large-v3-turbo-q5_0.bin'),
      vadModel: join(homedir(), '.halcyonic/speech/models/ggml-silero-v6.2.0.bin'),
    }),
    text: new VisionTextReader(join(serviceRoot, '.build/boopy-ocr')),
    speechOutput: neural ?? say,
  });
  const headset = headsetApp(boopy, { logger: false });
  const token = 'synthetic-real-local-rehearsal-token';
  const connector = connectorApp(boopy, { token, baseUrl: 'http://127.0.0.1', logger: false });
  const client = new Client({ name: 'synthetic-local-model-rehearsal', version: '1.0.0' });
  const directory = await mkdtemp(join(tmpdir(), 'boopy-synthetic-rehearsal-'));
  const measured = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    phase = name;
    const at = performance.now();
    try {
      return await work();
    } finally {
      timings[name] = Math.round(performance.now() - at);
    }
  };
  try {
    const inputVoice = await measured('inputSynthesis', () => say.synthesize(sourceWords, 'en'));
    const inputPath = join(directory, 'synthetic-input.wav');
    const resampledPath = join(directory, 'synthetic-input-16k.wav');
    await writeFile(inputPath, inputVoice.wav, { mode: 0o600 });
    await measured('resample', () =>
      run(
        '/opt/homebrew/bin/ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          resampledPath,
        ],
        { timeout: 10000 },
      ),
    );
    const wav = await readFile(resampledPath);
    const call = async (url: string, payload: unknown) => {
      const response = await headset.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      assert.equal(response.statusCode, 200, `Synthetic route failed during ${phase}`);
      return SessionView.parse(response.json());
    };
    const first = await measured('whisperOcrFirstAnswer', () =>
      call('/v1/sessions', {
        requestId: '900363a5-7221-468e-a733-92b654a052fc',
        frame: {
          ...frameOf('korean-notes.jpg'),
          source: 'displayed-image',
          timestampTrusted: false,
        },
        speech: { wav: wav.toString('base64') },
        cues: { gaze: { point: { x: 0.3, y: 0.22 }, onSurface: true } },
        device: { model: 'synthetic local probe', app: 'local-model-rehearsal' },
      }),
    );
    diagnostic.transcript = first.utterances[0]?.text;
    diagnostic.firstAnswer = first.dialogue?.text;
    assert.match(diagnostic.transcript ?? '', /Korean.*desert/i);
    assert.match(diagnostic.firstAnswer ?? '', /사막/);
    assert.match(diagnostic.firstAnswer ?? '', /desert/i);
    assert.ok(first.model?.provider === 'ollama');
    assert.equal(first.state, 'review');
    assert.ok(
      test.journal
        .all()
        .some(
          (event) =>
            event.type === 'text.read' &&
            event.data.lines.some((line) => line.text.includes('사막')),
        ),
    );
    const action = first.dialogue?.actions?.[0];
    assert.ok(action, 'Actual model returned no contextual follow-up.');
    diagnostic.question = action.question;
    assert.ok(first.dialogue);
    const second = await measured('selectedFollowup', () =>
      call(`/v1/sessions/${first.id}/utterances`, {
        speech: { text: action.question },
        cues: action.targetItemId === null ? {} : { targetItemId: action.targetItemId },
        selection: {
          utteranceId: first.dialogue?.utteranceId,
          responseAt: first.dialogue?.at,
          actionId: action.id,
        },
      }),
    );
    diagnostic.followupAnswer = second.dialogue?.text;
    options.reviewSynthetic?.({ question: action.question, answer: second.dialogue?.text ?? '' });
    assert.ok(second.dialogue?.text);
    const followupTranslationVerified = verifyFollowupTranslation(
      action.question,
      second.dialogue.text,
    );
    assert.notEqual(
      followupTranslationVerified,
      false,
      'Selected translation did not match the controlled synthetic note.',
    );
    assert.equal(second.state, 'review');
    assert.equal(second.committed, null);
    if (action.targetItemId !== null) assert.equal(second.referentId, action.targetItemId);
    assert.ok(
      test.journal
        .all()
        .some((event) => event.type === 'utterance.heard' && event.data.source === 'suggestion'),
    );
    assert.equal(
      second.items.some((item) => item.origin === 'person' || item.status === 'confirmed'),
      false,
    );
    assert.ok(second.dialogue);
    const spoken = await measured('replySynthesis', () =>
      boopy.speak(first.id, {
        utteranceId: second.dialogue?.utteranceId ?? '',
        responseAt: second.dialogue?.at ?? '',
      }),
    );
    assert.ok(Buffer.from(spoken.wav, 'base64').length > 44);
    const target = second.items.find((item) => item.id === second.referentId);
    assert.ok(target);
    const corrected = await measured('personalDetail', () =>
      call(`/v1/sessions/${first.id}/utterances`, {
        speech: { text: personalDetail },
        cues: { targetItemId: target.id },
      }),
    );
    assert.equal(corrected.items.find((item) => item.id === target.id)?.note, personalDetail);
    assert.equal(
      corrected.items.some((item) => item.status === 'confirmed'),
      false,
    );
    const saved = await measured('explicitCommit', () =>
      call(`/v1/sessions/${first.id}/commit`, {}),
    );
    assert.ok(saved.committed);
    const pkg = boopy.package(saved.committed.packageId);
    assert.ok(pkg);
    assert.ok(
      pkg.provenance.utterances.some(
        (utterance) =>
          utterance.source === 'suggestion' && utterance.selection?.actionId === action.id,
      ),
    );
    assert.ok(
      evidenceRecords(pkg).some(
        (record) => record.note === personalDetail && record.humanActions.length > 0,
      ),
    );
    assert.equal(
      evidenceRecords(pkg).some((record) => record.verification === 'confirmed'),
      false,
    );
    await measured('connectorReadback', async () => {
      await connector.listen({ host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${(connector.server.address() as AddressInfo).port}`;
      const headers = {
        authorization: `Bearer ${token}`,
        'x-boopy-agent': 'synthetic-local-rehearsal',
      };
      const rest = await fetch(`${base}/v1/context/${pkg.id}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(rest.status, 200);
      assert.deepEqual(await rest.json(), JSON.parse(JSON.stringify(pkg)));
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }),
      );
      const result = await client.callTool({ name: 'fetch', arguments: { id: pkg.id } });
      const content = result.content.find((part) => part.type === 'text');
      assert.ok(content && content.type === 'text');
      assert.deepEqual(JSON.parse(content.text).metadata.package, JSON.parse(JSON.stringify(pkg)));
    });
    return {
      passed: true,
      mode: 'actual-local-synthetic',
      timings,
      totalMs: Math.round(performance.now() - started),
      gates: [
        'Whisper request',
        'OCR exact Korean',
        'relevant translation',
        'generated contextual action',
        'informational selection',
        'personal attribution',
        'explicit commit',
        'REST/MCP readback',
      ],
      model: boopy.interpreter,
      replyVoice: spoken.voice,
      replySpeechProvider: speechOptions.provider,
      replyWavBytes: Buffer.from(spoken.wav, 'base64').length,
      followupTranslationVerified,
      storage: 'in-memory',
      limits:
        'Two synthetic model turns; no headset capture, audio playback, Muse delivery or wearer acceptance.',
    };
  } catch (error) {
    return {
      passed: false,
      mode: 'actual-local-synthetic',
      failedPhase: phase,
      failureGate:
        error instanceof assert.AssertionError
          ? error.message
          : 'Local adapter or route unavailable.',
      timings,
      totalMs: Math.round(performance.now() - started),
      syntheticDiagnostic: diagnostic,
    };
  } finally {
    neural?.close();
    connector.server.closeAllConnections();
    await Promise.allSettled([client.close(), headset.close(), connector.close()]);
    test.journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const result = await localModelRehearsal();
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
