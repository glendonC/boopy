import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FixtureInterpreter } from '../src/interpret/fixture.ts';
import { OllamaInterpreter } from '../src/interpret/ollama.ts';
import { repeatInput } from './repeat-stream-input.mjs';

test('three exact synthetic inputs retain fallback counters and redact all content', async (context) => {
  const input = {
    said: 'synthetic-secret-question',
    language: 'en',
    scope: 'auto',
    gaze: null,
    pointer: null,
    image: Buffer.from([255, 216, 255, 217]),
    crop: null,
    text: [],
    decisions: [],
  };
  const answer = await new FixtureInterpreter().interpret(input);
  const requests = [];
  const output = [];
  const original = globalThis.fetch;
  context.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return requests.length === 1
      ? new Response('structured output is unavailable', { status: 501 })
      : Response.json({
          message: { content: JSON.stringify(answer.output) },
          total_duration: 1000,
          load_duration: 100,
          prompt_eval_count: 20,
          prompt_eval_duration: 200,
          eval_count: 5,
          eval_duration: 300,
          private: 'synthetic-provider-secret',
        });
  });
  const mocked = globalThis.fetch;
  await repeatInput(
    input,
    new OllamaInterpreter({ url: 'http://127.0.0.1:11434', model: 'synthetic' }),
    (row) => output.push(row),
  );
  assert.equal(output.length, 3);
  assert.equal(requests.length, 4);
  assert.equal(new Set(output.map((row) => row.inputSha256)).size, 1);
  assert.deepEqual(
    output.map((row) => row.calls.map((call) => call.schemaFormat)),
    [[true, false], [false], [false]],
  );
  assert.ok(output.every((row) => row.schemaValid));
  assert.equal(output[0].calls[1].eval_count, 5);
  assert.doesNotMatch(
    JSON.stringify(output),
    /synthetic-secret|synthetic-provider|message|content|raw/,
  );
  assert.equal(globalThis.fetch, mocked);
  assert.notEqual(globalThis.fetch, original);
});

test('failed attempts still emit three numeric outcomes and return failure without provider text', async () => {
  const output = [];
  const original = globalThis.fetch;
  const passed = await repeatInput(
    { said: 'fictional-input', image: Buffer.from([1]) },
    {
      interpret: async () => {
        throw new Error('synthetic-provider-secret-output');
      },
    },
    (row) => output.push(row),
  );
  assert.equal(passed, false);
  assert.equal(output.length, 3);
  assert.ok(output.every((row) => row.schemaValid === false && row.calls.length === 0));
  assert.equal(new Set(output.map((row) => row.inputSha256)).size, 1);
  assert.doesNotMatch(JSON.stringify(output), /fictional-input|synthetic-provider-secret/);
  assert.equal(globalThis.fetch, original);
});
