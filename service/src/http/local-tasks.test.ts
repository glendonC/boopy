import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HandoffPreparation } from '../handoff-preparation.ts';
import { TaskStore } from '../interaction/tasks.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

const TOKEN = 'synthetic-task-route-token';
const NONCE = 'b'.repeat(32);
const CONNECT = { eventId: 'evt_connect_study', connectionId: 'con_study', label: 'My study chat' };

/** A session with its task open on the fixture's subject, and the connector beside it. */
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-task-routes-'));
  await writeFile(join(directory, 'connector-token'), TOKEN, { mode: 0o600 });
  const test = testBoopy();
  const tasks = new TaskStore(test.journal);
  const preparation = new HandoffPreparation({
    journal: test.journal,
    outputRoot: join(directory, 'handoffs'),
    dataDir: directory,
    port: 0,
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
  });
  const headset = headsetApp(test.boopy, { logger: false, tasks });
  const connector = connectorApp(test.boopy, {
    token: TOKEN,
    baseUrl: 'https://fictional.example',
    logger: false,
    handoff: preparation,
    tasks,
  });
  const capture = startRequest('What is this?');
  const session = await test.boopy.start({
    ...capture,
    frame: { ...capture.frame, source: 'current-surroundings', timestampTrusted: false },
    attention: {
      scope: 'target',
      evidence: 'visual',
      source: 'current-surroundings',
      ambiguousTarget: false,
      ocrRequested: false,
      segmentationRequested: false,
      maxAgeMs: 15000,
    },
  });
  const opened = await headset.inject({
    method: 'POST',
    url: `/v1/sessions/${session.id}/task`,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
    payload: { eventId: 'evt_open', taskId: 'tsk_route' },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  const local = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    connector.inject({
      method: 'POST',
      url,
      remoteAddress: '127.0.0.1',
      headers: { host: '127.0.0.1', authorization: `Bearer ${TOKEN}`, ...headers },
      payload: payload as object,
    });
  const request = (change: Record<string, unknown> = {}) =>
    local('/v1/local-tasks/requests', {
      eventId: 'evt_request_one',
      taskId: 'tsk_route',
      connectionId: 'con_study',
      requestId: 'trq_one',
      nonce: NONCE,
      ...change,
    });
  return {
    ...test,
    session,
    headset,
    connector,
    local,
    request,
    async close() {
      await connector.close();
      await headset.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('local operator routes for a connection reply', () => {
  it('names a connection, writes the request with the model’s confidence, and takes its reply', async () => {
    const ctx = await setup();
    try {
      const connected = await ctx.local('/v1/local-tasks/connections', CONNECT);
      assert.equal(connected.statusCode, 200, connected.body);
      assert.deepEqual(connected.json(), { connectionId: 'con_study', label: 'My study chat' });
      const prepared = await ctx.request();
      assert.equal(prepared.statusCode, 200, prepared.body);
      assert.equal(prepared.headers['cache-control'], 'no-store');
      const { requestId, fileName, file } = prepared.json();
      assert.equal(requestId, 'trq_one');
      assert.equal(fileName, 'boopy-request-trq_one.json');
      const body = JSON.parse(file);
      const subject = ctx.session.items.find((item) => item.id === ctx.session.referentId);
      assert.equal(body.task.subject.confidence, subject?.confidence);
      const reply = JSON.stringify({
        ...body.respondWith,
        components: [{ ...body.respondWith.components[0], text: 'A photo of a desert.' }],
      });
      const matched = await ctx.local('/v1/local-tasks/replies', { content: reply });
      assert.equal(matched.statusCode, 200, matched.body);
      assert.equal(matched.json().revision, 2);
      assert.deepEqual(matched.json().reply, { connection: 'My study chat' });
      assert.equal(matched.json().delivery, 'not-sent');
      const again = await ctx.local('/v1/local-tasks/replies', { content: reply });
      assert.deepEqual(again.json(), matched.json());
    } finally {
      await ctx.close();
    }
  });

  it('refuses a reply that does not match, cannot be read, or answers no request', async () => {
    const ctx = await setup();
    try {
      await ctx.local('/v1/local-tasks/connections', CONNECT);
      const body = JSON.parse((await ctx.request()).json().file);
      const filled = { ...body.respondWith.components[0], text: 'A photo of a desert.' };
      const cases: [unknown, number, string][] = [
        [
          { ...body.respondWith, components: [filled], nonce: 'c'.repeat(32) },
          409,
          'nonce_mismatch',
        ],
        [{ ...body.respondWith, components: [filled], sent: true }, 422, 'reply_invalid'],
        [
          { ...body.respondWith, components: [filled], requestId: 'trq_other' },
          404,
          'unknown_request',
        ],
        ['Here is my reply.', 400, 'reply_unreadable'],
      ];
      for (const [content, status, code] of cases) {
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        const refused = await ctx.local('/v1/local-tasks/replies', { content: text });
        assert.equal(refused.statusCode, status, code);
        assert.equal(refused.json().error.code, code);
      }
      const twice = await ctx.request({ eventId: 'evt_request_two', requestId: 'trq_two' });
      assert.equal(twice.statusCode, 409);
      assert.equal(twice.json().error.code, 'request_exists');
      assert.match(twice.json().error.message, /trq_one.*retry or cancel the task/);
      const nowhere = await ctx.request({
        eventId: 'evt_x',
        requestId: 'trq_x',
        connectionId: 'con_x',
      });
      assert.equal(nowhere.statusCode, 404);
      assert.equal(nowhere.json().error.code, 'unknown_connection');
    } finally {
      await ctx.close();
    }
  });

  it('answers only the local operator with the token, and not on the headset API', async () => {
    const ctx = await setup();
    try {
      const url = '/v1/local-tasks/connections';
      const tokenless = await ctx.connector.inject({
        method: 'POST',
        url,
        remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1' },
        payload: CONNECT,
      });
      assert.equal(tokenless.statusCode, 401);
      const remote = await ctx.connector.inject({
        method: 'POST',
        url,
        remoteAddress: '10.0.0.2',
        headers: { host: '127.0.0.1', authorization: `Bearer ${TOKEN}` },
        payload: CONNECT,
      });
      assert.equal(remote.statusCode, 403);
      const forwarded = await ctx.local(url, CONNECT, { 'x-forwarded-for': '10.0.0.2' });
      assert.equal(forwarded.statusCode, 403);
      const headset = await ctx.headset.inject({
        method: 'POST',
        url,
        headers: { host: '127.0.0.1' },
        payload: CONNECT,
      });
      assert.equal(headset.statusCode, 404);
      assert.equal(
        ctx.journal.all().some((event) => event.type === 'connection.created'),
        false,
      );
    } finally {
      await ctx.close();
    }
  });
});
