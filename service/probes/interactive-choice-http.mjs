/** Isolated fictional-only HTTP harness; importing never calls a provider or opens a listener. */
import assert from 'node:assert/strict';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { headsetApp } from '../src/http/headset.ts';
import { OllamaInterpreter } from '../src/interpret/ollama.ts';
import { testBoopy } from '../src/testing.ts';
import { interactiveChoiceRequest } from './interactive-choice.mjs';

export async function startInteractiveChoiceHttp({ interpreter, outputDirectory, ttlMs = 600000 }) {
  assert.ok(Number.isInteger(ttlMs) && ttlMs >= 100 && ttlMs <= 600000);
  const directory = await lstat(outputDirectory);
  assert.ok(
    directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o777) === 0o700,
    'Harness requires an empty private0700 directory.',
  );
  assert.equal(
    (await readdir(outputDirectory)).length,
    0,
    'Harness does not overwrite prior evidence.',
  );
  const wallMs = [];
  let calls = 0;
  const tracked = {
    provider: interpreter.provider,
    model: interpreter.model,
    async interpret(input, signal) {
      assert.ok(
        calls < 2,
        'This fictional harness permits only one initial and one submitted model turn.',
      );
      calls++;
      const started = performance.now();
      try {
        return await interpreter.interpret(input, signal);
      } finally {
        wallMs.push(Math.round(performance.now() - started));
      }
    },
  };
  const { boopy, journal } = testBoopy({ interpreter: tracked });
  const app = headsetApp(boopy, { logger: false });
  let timer;
  let closed = false;
  let baseUrl = null;
  let sessionId = null;
  let initialSessionView = null;
  const counts = { selections: 0, submissions: 0 };
  const save = (name, value) =>
    writeFile(join(outputDirectory, name), JSON.stringify(value), { mode: 0o600 });
  const metadata = () => ({
    synthetic: true,
    running: !closed,
    baseUrl,
    sessionId,
    initialSessionView,
    provider: interpreter.provider,
    model: interpreter.model,
    interpreterCalls: calls,
    counts,
    wallMs,
    externalDelivery: 'not-attempted',
    inMemoryJournal: true,
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    await app.close();
    journal.close();
    await save('metadata.json', metadata());
  };
  try {
    const first = await boopy.start(interactiveChoiceRequest());
    assert.ok(
      first.dialogue?.choice && first.dialogue.text.trim() === first.dialogue.choice.prompt.trim(),
      'Configured provider did not return a usable exact-question choice.',
    );
    sessionId = first.id;
    initialSessionView = first;
    await save('initial-session-view.json', first);
    const originalSelect = boopy.selectChoice.bind(boopy);
    boopy.selectChoice = async (...args) => {
      const result = await originalSelect(...args);
      counts.selections++;
      await save('selected-session-view.json', result);
      await save('metadata.json', metadata());
      return result;
    };
    const originalSubmit = boopy.submitChoice.bind(boopy);
    boopy.submitChoice = async (...args) => {
      // Streaming installs its progress scope by calling submitChoice again without callback.
      if (args[2] !== undefined) return originalSubmit(...args);
      const result = await originalSubmit(...args);
      counts.submissions++;
      await save('final-session-view.json', result);
      await save('metadata.json', metadata());
      return result;
    };
    const allowed = new Set([
      '/v1/health',
      `/v1/sessions/${sessionId}`,
      `/v1/sessions/${sessionId}/choice-selection`,
      `/v1/sessions/${sessionId}/choice-submit`,
    ]);
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      const read = path === '/v1/health' || path === `/v1/sessions/${sessionId}`;
      if (!allowed.has(path) || request.method !== (read ? 'GET' : 'POST'))
        return reply.code(404).send({
          error: {
            code: 'synthetic_harness_scope',
            message: 'Outside this fictional choice rehearsal.',
          },
        });
    });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await save('metadata.json', metadata());
    timer = setTimeout(() => {
      void close();
    }, ttlMs);
    return { baseUrl, sessionId, close, metadata };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDirectory = process.argv[2];
  if (!outputDirectory || process.argv.length !== 3) {
    process.stderr.write('Provide one empty private0700 output directory.\n');
    process.exitCode = 1;
  } else {
    try {
      const harness = await startInteractiveChoiceHttp({
        outputDirectory,
        interpreter: new OllamaInterpreter({
          url: 'http://127.0.0.1:11434',
          model: 'qwen3.6:35b-a3b-nvfp4',
          timeoutMs: 55000,
          think: false,
        }),
      });
      for (const signal of ['SIGINT', 'SIGTERM'])
        process.once(signal, () => {
          void harness.close();
        });
      process.stdout.write(`${JSON.stringify(harness.metadata())}\n`);
    } catch {
      process.stderr.write('Fictional HTTP choice harness failed; no provider content printed.\n');
      process.exitCode = 1;
    }
  }
}
