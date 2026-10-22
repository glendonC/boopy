import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { Boopy } from './boopy.ts';
import { headsetApp } from './http/headset.ts';
import { FixtureInterpreter } from './interpret/fixture.ts';
import { startRequest, testBoopy } from './testing.ts';

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bounded<T>(promise: Promise<T>, phase: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Synthetic HTTP phase did not complete: ${phase}`)),
      5000,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
async function listen(app: FastifyInstance) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
async function stop(app: FastifyInstance) {
  app.server.closeAllConnections();
  await app.close();
}

describe('real loopback first-start disconnect recovery', () => {
  it('aborted POST keeps pending association, completes once, and read-only lookup recovers actual view after replay', async () => {
    const requestId = '1f8b09b5-fb8e-46be-bd9e-d105c7be8daf';
    const entered = deferred(),
      release = deferred(),
      disconnected = deferred(),
      finished = deferred();
    let interpretations = 0,
      posts = 0;
    const fixture = new FixtureInterpreter();
    const { boopy, deps, journal } = testBoopy({
      interpreter: {
        provider: 'fixture',
        model: 'synthetic-http-barrier',
        async interpret(input) {
          interpretations++;
          entered.resolve();
          await release.promise;
          return fixture.interpret(input);
        },
      },
    });
    // Observe the durable terminal event rather than guessing completion with sleeps.
    const append = journal.append.bind(journal);
    journal.append = (event, id, at) => {
      const record = append(event, id, at);
      if (event.type === 'session.start.finished') finished.resolve();
      return record;
    };
    const app = headsetApp(boopy, { logger: false });
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'POST' && request.url === '/v1/sessions') {
        posts++;
        reply.raw.once('close', () => disconnected.resolve());
      }
    });
    const cancel = new AbortController();
    let replayApp: FastifyInstance | undefined;
    let post: Promise<Response> | undefined;
    try {
      const base = await listen(app);
      post = fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...startRequest('Synthetic HTTP capture.'), requestId }),
        signal: cancel.signal,
      });
      // Handle rejection immediately, including failure before the interpreter barrier.
      const postOutcome = post.then(
        () => 'unexpected-response',
        (error) => error,
      );
      await bounded(entered.promise, 'interpreter entry');
      cancel.abort();
      const abort = await bounded(postOutcome, 'client abort');
      assert.ok(abort instanceof Error && abort.name === 'AbortError');
      await bounded(disconnected.promise, 'server response socket close');
      const pendingResponse = await fetch(`${base}/v1/session-starts/${requestId}`);
      assert.equal(pendingResponse.status, 200);
      assert.equal(pendingResponse.headers.get('cache-control'), 'no-store');
      const pending = await pendingResponse.json();
      assert.equal(pending.status, 'pending');
      assert.equal(pending.view, null);
      assert.ok(pending.sessionId);
      release.resolve();
      await bounded(finished.promise, 'durable completion');
      const ready = await fetch(`${base}/v1/session-starts/${requestId}`);
      const recovery = await ready.json();
      assert.equal(ready.status, 200);
      assert.equal(recovery.status, 'succeeded');
      assert.equal(recovery.requestId, requestId);
      assert.equal(recovery.sessionId, pending.sessionId);
      assert.deepEqual(recovery.view, JSON.parse(JSON.stringify(boopy.view(pending.sessionId))));
      assert.equal(
        recovery.view.items.every((item: { status: string }) => item.status === 'proposed'),
        true,
      );
      assert.equal(posts, 1);
      assert.equal(interpretations, 1);
      for (const type of [
        'session.started',
        'observation.recorded',
        'utterance.heard',
        'interpretation.proposed',
        'session.start.finished',
      ])
        assert.equal(journal.all().filter((event) => event.type === type).length, 1, type);
      const count = journal.all().length;
      replayApp = headsetApp(new Boopy(deps), { logger: false });
      const replayBase = await listen(replayApp);
      const replayResponse = await fetch(`${replayBase}/v1/session-starts/${requestId}`);
      assert.equal(replayResponse.status, 200);
      assert.deepEqual(await replayResponse.json(), recovery);
      assert.equal(journal.all().length, count);
      assert.equal(posts, 1);
      assert.equal(interpretations, 1);
    } finally {
      cancel.abort();
      release.resolve();
      if (post) await post.catch(() => {});
      if (replayApp) await stop(replayApp);
      await stop(app);
      journal.close();
    }
  });

  it('real failed start remains a failed receipt after reconstructing service state', async () => {
    const requestId = '058d8c87-e280-4110-8a01-ebf31492791f';
    const { boopy, deps, journal } = testBoopy();
    const app = headsetApp(boopy, { logger: false });
    let replayApp: FastifyInstance | undefined;
    try {
      const base = await listen(app);
      const response = await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...startRequest('Synthetic rejected frame.'),
          requestId,
          frame: { ...startRequest('Synthetic').frame, jpeg: 'synthetic-not-jpeg' },
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_frame');
      const count = journal.all().length;
      replayApp = headsetApp(new Boopy(deps), { logger: false });
      const replayBase = await listen(replayApp);
      const failedResponse = await fetch(`${replayBase}/v1/session-starts/${requestId}`);
      assert.equal(failedResponse.status, 200);
      assert.equal(failedResponse.headers.get('cache-control'), 'no-store');
      const failed = await failedResponse.json();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failureCode, 'invalid_frame');
      assert.equal(failed.view, null);
      assert.ok(failed.sessionId);
      assert.equal(journal.all().length, count);
      assert.equal(journal.all().filter((event) => event.type === 'session.started').length, 1);
      assert.equal(
        journal.all().filter((event) => event.type === 'observation.recorded').length,
        0,
      );
    } finally {
      if (replayApp) await stop(replayApp);
      await stop(app);
      journal.close();
    }
  });
});
