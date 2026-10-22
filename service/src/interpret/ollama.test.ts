import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { InterpretInput } from './interpreter.ts';
import { OllamaInterpreter } from './ollama.ts';

const input: InterpretInput = {
  said: 'Synthetic question.',
  language: 'en',
  scope: 'auto',
  gaze: null,
  pointer: null,
  image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  crop: null,
  text: [],
  decisions: [],
};

test('structured-output refusal and fallback share one interpretation deadline', async (context) => {
  const signals: AbortSignal[] = [];
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const signal = init.signal;
    assert.ok(signal);
    signals.push(signal);
    if (signals.length === 1) {
      return new Response('structured output is unavailable', { status: 501 });
    }
    // A real fetch's response-body read observes the same abort deadline.
    await delay(10000, undefined, { signal });
    throw new Error('Synthetic request should have timed out.');
  });
  const interpreter = new OllamaInterpreter({
    url: 'http://127.0.0.1:11434',
    model: 'synthetic-only',
    timeoutMs: 30,
  });
  await assert.rejects(interpreter.interpret(input), { name: 'AbortError' });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1], 'fallback must not receive a renewed timeout');
  assert.equal(signals[1]?.aborted, true);
});

test('caller cancellation remains effective through schema fallback', async (context) => {
  const cancel = new AbortController();
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 1) {
      return new Response('structured output is unavailable', { status: 501 });
    }
    cancel.abort();
    await delay(10000, undefined, { signal: init.signal ?? undefined });
    throw new Error('Synthetic request should have been cancelled.');
  });
  const interpreter = new OllamaInterpreter({
    url: 'http://127.0.0.1:11434',
    model: 'synthetic-only',
  });
  await assert.rejects(interpreter.interpret(input, cancel.signal), { name: 'AbortError' });
  assert.equal(calls, 2);
});
