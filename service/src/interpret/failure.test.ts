import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Boopy } from '../boopy.ts';
import { SessionView } from '../contracts.ts';
import { headsetApp } from '../http/headset.ts';
import { Projection } from '../session.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { FixtureInterpreter } from './fixture.ts';
import { OllamaInterpreter } from './ollama.ts';
import { InterpretError, ModelOutputError } from './output.ts';

test('actual isolated connection refusal is a sanitized typed latest-turn failure and survives replay', async () => {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const { boopy, journal, deps } = testBoopy({
    interpreter: new OllamaInterpreter({
      url: `http://127.0.0.1:${address.port}`,
      model: 'synthetic-offline',
    }),
  });
  const app = headsetApp(boopy, { logger: false });
  try {
    const request = startRequest('What is in this synthetic picture?');
    const requestId = randomUUID();
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        ...request,
        requestId,
        frame: { ...request.frame, source: 'current-surroundings', timestampTrusted: false },
        attention: { scope: 'scene', evidence: 'visual', source: 'current-surroundings' },
      },
    });
    assert.equal(reply.statusCode, 200);
    const view = SessionView.parse(reply.json());
    assert.equal(view.interpretationFailure?.code, 'interpreter_unavailable');
    assert.equal(view.interpretationFailure.utteranceId, view.utterances.at(-1)?.id);
    assert.equal(
      view.dialogue?.text,
      'I can’t reach the model on your Mac. Try again once it’s running.',
    );
    assert.deepEqual(view.items, []);
    assert.equal(view.model, null);
    assert.equal(
      journal.all().some((event) => event.type === 'interpretation.proposed'),
      false,
    );
    assert.doesNotMatch(JSON.stringify(view), /ECONNREFUSED|fetch failed|127\.0\.0\.1/);
    const replayed = new Boopy(deps).startStatus(requestId).view;
    assert.deepEqual(replayed?.interpretationFailure, view.interpretationFailure);
    assert.deepEqual(replayed?.items, []);
    const legacy = Projection.from(
      journal
        .all()
        .map((event) =>
          event.type === 'interpretation.failed'
            ? { ...event, data: { ...event.data, code: undefined } }
            : event,
        ),
    );
    assert.equal(legacy.session(view.id)?.interpretationFailure?.code, 'interpreter_failed');
  } finally {
    await app.close();
    journal.close();
  }
});
test('generic provider failures retain safe wording, do not promote confidence, and next turn clears failure', async () => {
  const fixture = new FixtureInterpreter();
  let failing = false;
  const { boopy, journal } = testBoopy({
    interpreter: {
      provider: 'synthetic',
      model: 'synthetic',
      async interpret(input) {
        if (failing) throw new Error('PRIVATE_PROVIDER_BODY secret-key');
        return fixture.interpret(input);
      },
    },
  });
  try {
    const first = await boopy.start(startRequest('Synthetic travel picture'));
    const noted = await boopy.utter(first.id, {
      speech: { text: 'Add a synthetic personal note' },
    });
    assert.ok(noted.items.some((item) => item.confidence === null));
    const original = structuredClone(noted.items);
    failing = true;
    const failed = await boopy.utter(first.id, {
      speech: { text: 'What objects are in this picture?' },
      frame: startRequest('synthetic').frame,
      cues: {},
    });
    assert.equal(failed.interpretationFailure?.code, 'interpreter_failed');
    assert.equal(failed.notice, 'Could not interpret that. Please try again.');
    assert.deepEqual(failed.items, original);
    assert.doesNotMatch(JSON.stringify(journal.all()), /PRIVATE_PROVIDER_BODY|secret-key/);
    failing = false;
    const next = await boopy.utter(first.id, { speech: { text: 'Add a synthetic personal note' } });
    assert.equal(next.interpretationFailure, null);
  } finally {
    journal.close();
  }
});

test('only explicit refusal on loopback Ollama gets the local-unavailable classification', async (context) => {
  let code = 'ECONNRESET';
  context.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('PRIVATE_TRANSPORT', { cause: { code } });
  });
  for (const url of ['http://127.0.0.1:11434', 'https://synthetic-provider.invalid']) {
    code = url.startsWith('https') ? 'ECONNREFUSED' : 'ECONNRESET';
    const { boopy, journal } = testBoopy({
      interpreter: new OllamaInterpreter({ url, model: 'synthetic' }),
    });
    try {
      const view = await boopy.start(startRequest('Synthetic unavailable request'));
      assert.equal(view.interpretationFailure?.code, 'interpreter_failed');
      assert.doesNotMatch(JSON.stringify(view), /PRIVATE_TRANSPORT|ECONN/);
      const old = { ...view };
      delete old.interpretationFailure;
      assert.ok(SessionView.safeParse(old).success);
    } finally {
      journal.close();
    }
  }
});

test('an answer that misses the schema is tried once more with the same inputs, and both tries are journaled', async () => {
  const fixture = new FixtureInterpreter();
  const said: string[] = [];
  let misses = 1;
  const { boopy, journal } = testBoopy({
    interpreter: {
      provider: 'synthetic',
      model: 'synthetic',
      async interpret(input) {
        said.push(input.said);
        if (misses > 0) {
          misses -= 1;
          // Ollama's qwen once sent a string where the schema wants an object.
          throw new ModelOutputError(
            "The model's JSON does not match: Invalid input: expected object, received string",
            '{"synthetic": true}',
          );
        }
        return fixture.interpret(input);
      },
    },
  });
  try {
    const view = await boopy.start(startRequest('What is this?'));
    assert.equal(view.interpretationFailure ?? null, null);
    assert.ok(view.items.some((item) => item.id === view.referentId));
    assert.deepEqual(said, ['What is this?', 'What is this?']);
    assert.deepEqual(
      journal
        .all()
        .map((event) => event.type)
        .filter((type) => type.startsWith('interpretation.')),
      ['interpretation.retried', 'interpretation.proposed'],
    );

    // Missing it twice ends the turn with today's honest line, after exactly two tries.
    misses = 2;
    said.length = 0;
    const twice = await boopy.start(startRequest('What is this?'));
    assert.equal(twice.interpretationFailure?.code, 'interpreter_failed');
    assert.equal(twice.notice, 'Could not interpret that. Please try again.');
    assert.equal(said.length, 2);
  } finally {
    journal.close();
  }
});

test('a failure that is not a schema miss is not retried', async () => {
  let calls = 0;
  const { boopy, journal } = testBoopy({
    interpreter: {
      provider: 'synthetic',
      model: 'synthetic',
      async interpret() {
        calls += 1;
        throw new InterpretError('Ollama answered 500.', '');
      },
    },
  });
  try {
    const view = await boopy.start(startRequest('What is this?'));
    assert.equal(view.interpretationFailure?.code, 'interpreter_failed');
    assert.equal(calls, 1);
    assert.equal(
      journal.all().some((event) => event.type === 'interpretation.retried'),
      false,
    );
  } finally {
    journal.close();
  }
});
