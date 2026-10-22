import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FixtureInterpreter } from '../src/interpret/fixture.ts';
import { startInteractiveChoiceHttp } from './interactive-choice-http.mjs';

const fixture = new FixtureInterpreter();
function interpreter() {
  return {
    provider: 'fixture',
    model: 'http-choice-synthetic',
    async interpret(input) {
      const result = await fixture.interpret(input);
      const output = {
        ...result.output,
        response: input.inputSource === 'choice' ? 'A fictional next reply.' : 'Which description?',
        choice:
          input.inputSource === 'choice'
            ? null
            : {
                kind: 'choice',
                prompt: 'Which description?',
                options: [
                  { label: 'Name it', value: 'Name it' },
                  { label: 'Colors', value: 'Colors' },
                ],
              },
      };
      return { output, raw: JSON.stringify(output) };
    },
  };
}

test('isolated HTTP harness seeds once, persists actual select/stream result and denies unrelated capture routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-fictional-http-'));
  let harness;
  try {
    harness = await startInteractiveChoiceHttp({
      interpreter: interpreter(),
      outputDirectory: directory,
    });
    const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'));
    assert.equal(metadata.interpreterCalls, 1);
    assert.equal(metadata.initialSessionView.id, harness.sessionId);
    assert.match(harness.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const initial = await (
      await fetch(`${harness.baseUrl}/v1/sessions/${harness.sessionId}`)
    ).json();
    const card = initial.dialogue.choice;
    const binding = {
      utteranceId: initial.dialogue.utteranceId,
      responseAt: initial.dialogue.at,
      cardId: card.id,
      optionId: card.options[0].id,
    };
    const selected = await fetch(
      `${harness.baseUrl}/v1/sessions/${harness.sessionId}/choice-selection`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(binding),
      },
    );
    assert.equal(selected.status, 200);
    assert.equal(harness.metadata().interpreterCalls, 1);
    assert.equal(harness.metadata().counts.selections, 1);
    const submitted = await fetch(
      `${harness.baseUrl}/v1/sessions/${harness.sessionId}/choice-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(binding),
      },
    );
    const terminal = (await submitted.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(terminal.type, 'result');
    assert.equal(terminal.view.dialogue.text, 'A fictional next reply.');
    assert.equal(harness.metadata().interpreterCalls, 2);
    assert.equal(harness.metadata().counts.submissions, 1);
    const denied = await fetch(`${harness.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(denied.status, 404);
    for (const file of [
      'metadata.json',
      'initial-session-view.json',
      'selected-session-view.json',
      'final-session-view.json',
    ])
      assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    await harness.close();
    await harness.close();
    assert.equal(
      JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')).running,
      false,
    );
  } finally {
    await harness?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('bounded TTL closes its own listener and retains explicit stopped metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-fictional-http-ttl-'));
  let harness;
  try {
    harness = await startInteractiveChoiceHttp({
      interpreter: interpreter(),
      outputDirectory: directory,
      ttlMs: 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await assert.rejects(fetch(`${harness.baseUrl}/v1/health`));
    assert.equal(
      JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8')).running,
      false,
    );
  } finally {
    await harness?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
