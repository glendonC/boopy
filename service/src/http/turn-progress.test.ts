import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { FixtureInterpreter } from '../interpret/fixture.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { headsetApp } from './headset.ts';

const headers = { accept: 'application/x-ndjson', 'content-type': 'application/json' };
const lines = (body: string) =>
  body
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
test('real stages arrive before delayed answer with provenance and no raw fragments', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = new FixtureInterpreter();
  const setup = testBoopy({
    segmenter: {
      provider: 'meta',
      model: 'sam-3.1',
      segment: async () => ({ outcome: 'no-match', latencyMs: 0, confidence: null }),
    },
    interpreter: {
      provider: 'fixture',
      model: 'synthetic',
      async interpret(input) {
        await held;
        return fixture.interpret(input);
      },
    },
  });
  const app = headsetApp(setup.boopy, { logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  try {
    const port = (app.server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(startRequest('What is this?')),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/x-ndjson/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.body);
    const reader = response.body.getReader();
    let body = '';
    while (!body.includes('interpreting')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      body += new TextDecoder().decode(chunk.value);
    }
    assert.ok(lines(body).every((event) => event.type === 'stage'));
    release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += new TextDecoder().decode(chunk.value);
    }
    const events = lines(body);
    assert.deepEqual(
      events.filter((event) => event.type === 'stage').map((event) => event.stage),
      ['reading-text', 'interpreting', 'refining-geometry'],
    );
    assert.equal(events.at(-1).type, 'result');
    assert.equal(events.filter((event) => event.type === 'result').length, 1);
    assert.deepEqual(Object.keys(events[0]).sort(), ['stage', 'type']);
    const journal = setup.journal.all().filter((event) => event.type === 'turn.processing');
    assert.equal(journal.length, 3);
    for (const event of journal) {
      assert.ok(event.data.utteranceId);
      assert.ok(event.data.observationId);
      assert.equal(event.session, events.at(-1).view.id);
    }
    assert.ok(
      events.at(-1).view.items.every((item: { status: string }) => item.status === 'proposed'),
    );
  } finally {
    release();
    await app.close();
    setup.journal.close();
  }
});
test('speech failure streams actual transcription only with sanitized terminal error', async () => {
  const setup = testBoopy();
  const app = headsetApp(setup.boopy, { logger: false });
  setup.speech.transcribe = async () => {
    throw new Error('synthetic-private-token/path/transcript');
  };
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: {
        cues: {},
        speech: { wav: 'UklGRg==' },
        attention: { scope: 'scene', evidence: 'none', source: 'unknown' },
      },
    });
    assert.equal(response.statusCode, 200);
    const events = lines(response.body);
    assert.deepEqual(
      events.map((event) => event.type),
      ['stage', 'error'],
    );
    assert.equal(events[0].stage, 'transcribing');
    assert.equal(events[1].error.code, 'speech_failed');
    assert.doesNotMatch(response.body, /synthetic-private|token|transcript/);
    const event = setup.journal.all().find((event) => event.type === 'turn.processing');
    assert.equal(event?.data.utteranceId, null);
    assert.equal(event?.data.observationId, null);
    const legacy = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: {
        cues: {},
        speech: { wav: 'UklGRg==' },
        attention: { scope: 'scene', evidence: 'none', source: 'unknown' },
      },
    });
    assert.equal(legacy.statusCode, 502);
    assert.equal(legacy.json().error.code, 'speech_failed');
    assert.doesNotMatch(legacy.body, /synthetic-private|token|transcript/);
  } finally {
    await app.close();
    setup.journal.close();
  }
});
test('legacy JSON, prestream validation and typed context do not invent stages', async () => {
  const setup = testBoopy();
  const app = headsetApp(setup.boopy, { logger: false });
  const payload = {
    cues: {},
    speech: { text: 'For this fictional account I walked before noon.' },
    attention: { scope: 'scene', evidence: 'none', source: 'unknown' },
  };
  try {
    const normal = await app.inject({ method: 'POST', url: '/v1/sessions', payload });
    assert.equal(normal.statusCode, 200);
    assert.ok(normal.json().id);
    const streamed = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload });
    assert.deepEqual(
      lines(streamed.body).map((event) => event.type),
      ['result'],
    );
    const invalid = await app.inject({ method: 'POST', url: '/v1/sessions', headers, payload: {} });
    assert.equal(invalid.statusCode, 400);
    assert.match(String(invalid.headers['content-type']), /application\/json/);
    assert.equal(setup.journal.all().filter((event) => event.type === 'turn.processing').length, 0);
  } finally {
    await app.close();
    setup.journal.close();
  }
});
test('concurrent scopes cannot leak stages and broken observer cannot fail journaled work', async () => {
  const setup = testBoopy();
  const first: string[] = [];
  const second: string[] = [];
  try {
    await Promise.all([
      setup.boopy.start(startRequest('What is this?'), (stage) => first.push(stage)),
      setup.boopy.start(startRequest('What is this?'), (stage) => second.push(stage)),
    ]);
    assert.deepEqual(first, ['reading-text', 'interpreting']);
    assert.deepEqual(second, first);
    const view = await setup.boopy.start(startRequest('What is this?'), () => {
      throw new Error('disconnected synthetic observer');
    });
    assert.ok(view.items.length);
  } finally {
    setup.journal.close();
  }
});

test('disconnected streaming first start retains exact recovery identity and never replays mutation', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const fixture = new FixtureInterpreter();
  const setup = testBoopy({
    interpreter: {
      provider: 'fixture',
      model: 'synthetic',
      async interpret(input) {
        calls++;
        await held;
        return fixture.interpret(input);
      },
    },
  });
  const app = headsetApp(setup.boopy, { logger: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const request = {
    ...startRequest('What is this?'),
    requestId: '11111111-1111-4111-8111-111111111111',
  };
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    assert.ok(response.body);
    const reader = response.body.getReader();
    let body = '';
    while (!body.includes('interpreting')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      body += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    release();
    for (
      let attempt = 0;
      attempt < 50 && setup.boopy.startStatus(request.requestId).status !== 'succeeded';
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(setup.boopy.startStatus(request.requestId).status, 'succeeded');
    assert.equal(calls, 1);
    const resumed = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: request,
    });
    const events = lines(resumed.body);
    assert.deepEqual(
      events.map((event) => event.type),
      ['result'],
    );
    assert.equal(calls, 1);
    const uttered = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${events[0].view.id}/utterances`,
      headers,
      payload: { speech: { text: 'What is this?' }, cues: {} },
    });
    assert.equal(lines(uttered.body).at(-1).type, 'result');
    assert.equal(calls, 2);
  } finally {
    release();
    await app.close();
    setup.journal.close();
  }
});

test('oversized terminal views become one bounded error without partial answer content', async (context) => {
  const setup = testBoopy();
  const app = headsetApp(setup.boopy, { logger: false });
  try {
    const request = startRequest('What is this?');
    const view = await setup.boopy.start(request);
    context.mock.method(setup.boopy, 'start', async () => ({
      ...view,
      notice: `synthetic-bounded-marker${'x'.repeat(2 * 1024 * 1024)}`,
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers,
      payload: request,
    });
    const events = lines(response.body);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].error.code, 'response_too_large');
    assert.ok(Buffer.byteLength(response.body) < 1000);
    assert.doesNotMatch(response.body, /synthetic-bounded-marker/);
  } finally {
    await app.close();
    setup.journal.close();
  }
});
