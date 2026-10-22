/** Explicit fictional-only provider benchmark. No journal, OCR service, voice or device access. */
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { prepareEvidence } from '../src/evidence.ts';
import type { InterpretInput } from '../src/interpret/interpreter.ts';
import { OllamaInterpreter } from '../src/interpret/ollama.ts';

const model = 'qwen3.6:35b-a3b-nvfp4';
const originalFetch = globalThis.fetch;
let calls: Record<string, number>[] = [];
// This isolated process observes only its own synthetic requests through the real adapter.
globalThis.fetch = async (...args) => {
  const started = performance.now();
  const response = await originalFetch(...args);
  const raw: unknown = await response.clone().json();
  const metrics: Record<string, number> = {
    status: response.status,
    wallMs: Math.round(performance.now() - started),
  };
  if (raw !== null && typeof raw === 'object')
    for (const key of [
      'total_duration',
      'load_duration',
      'prompt_eval_count',
      'prompt_eval_cached_count',
      'prompt_eval_duration',
      'eval_count',
      'eval_duration',
    ]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[key] = value;
    }
  calls.push(metrics);
  return response;
};
try {
  const interpreter = new OllamaInterpreter({
    url: 'http://127.0.0.1:11434',
    model,
    think: false,
    timeoutMs: 120000,
  });
  for (const fixture of ['korean-notes.jpg', 'desert-photo.jpg'] as const) {
    const image = await readFile(new URL(`../fixtures/images/${fixture}`, import.meta.url));
    const evidence = await prepareEvidence(image, { gaze: { x: 0.3, y: 0.22 }, pointer: null });
    const smaller = await sharp(evidence.marked)
      .resize({ width: 768, withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    const input: InterpretInput = {
      said:
        fixture === 'korean-notes.jpg'
          ? 'What is the Korean word for desert in this note?'
          : 'What is the Korean word for desert in this fictional photo?',
      language: 'en',
      scope: 'auto',
      gaze: { x: 0.3, y: 0.22 },
      pointer: null,
      image: evidence.marked,
      crop: evidence.crop,
      text: [],
      decisions: [],
      sourceContext: {
        source: 'displayed-image',
        capturedAt: '1970-01-01T00:00:00Z',
        timestampTrusted: false,
        selectionReason: 'Fictional repository fixture; no personal activity established.',
      },
    };
    for (const variant of ['native', '768-main-native-crop', 'native-repeat'] as const) {
      calls = [];
      const started = performance.now();
      try {
        const result = await interpreter.interpret({
          ...input,
          image: variant === '768-main-native-crop' ? smaller : evidence.marked,
        });
        console.log(
          JSON.stringify({
            fixture,
            variant,
            model,
            wallMs: Math.round(performance.now() - started),
            calls,
            schemaValid: true,
            requestedTermPresent: result.output.response?.includes('사막') ?? false,
            items: result.output.items.length,
          }),
        );
      } catch {
        console.log(JSON.stringify({ fixture, variant, model, failed: true, calls }));
        process.exitCode = 1;
      }
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}
