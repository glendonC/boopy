import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { it } from 'node:test';
import { createQuestHealthProbe } from './quest-health-probe.ts';

it('actual HTTP health is production-shaped and every other read or upload is denied before parsing', async () => {
  const probe = await createQuestHealthProbe({ port: 0 });
  try {
    const health = await fetch(`${probe.origin}/v1/health`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'boopy',
      speechOutputAvailable: false,
      handoffPreparationAvailable: false,
      interpreter: { provider: 'fixture', model: 'recorded-desert-trip' },
      segmenter: null,
      liveScene: null,
    });
    for (const body of ['{invalid json', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
      const upload = await fetch(`${probe.origin}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(upload.status, 403);
      assert.equal((await upload.json()).error.code, 'diagnostic_only');
    }
    for (const path of [
      '/v1/sessions/synthetic',
      '/v1/session-starts/synthetic',
      '/v1/health?synthetic=true',
      '/v1/%68ealth',
    ]) {
      const denied = await fetch(`${probe.origin}${path}`);
      assert.equal(denied.status, 403);
      assert.equal((await denied.json()).error.code, 'diagnostic_only');
    }
    assert.deepEqual(probe.checkpoint(), {
      mode: 'synthetic-health-only',
      loopbackOnly: true,
      healthReads: 1,
      deniedRequests: 6,
      journalEvents: 0,
      mediaWrites: 0,
      actualWearerCapture: 'unverified',
    });
  } finally {
    await probe.close();
    await probe.close();
  }
  assert.equal(probe.checkpoint().journalEvents, 0);
  assert.equal(probe.app.server.listening, false);
});

it('rejects body-bearing GET health requests before parsing or counting a health read', async () => {
  const probe = await createQuestHealthProbe({ port: 0 });
  try {
    for (const headers of [{ 'content-length': '8' }, { 'transfer-encoding': 'chunked' }]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          `${probe.origin}/v1/health`,
          { method: 'GET', headers },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          },
        );
        request.once('error', reject);
        request.end('syntheti');
      });
      assert.equal(status, 403);
    }
    assert.equal(probe.checkpoint().healthReads, 0);
    assert.equal(probe.checkpoint().deniedRequests, 2);
    assert.equal(probe.checkpoint().journalEvents, 0);
    assert.equal(probe.checkpoint().mediaWrites, 0);
  } finally {
    await probe.close();
  }
});

it('expires and cleans its isolated listener within the bounded TTL', async () => {
  const probe = await createQuestHealthProbe({ port: 0, ttlMs: 25 });
  await probe.closed;
  assert.equal(probe.app.server.listening, false);
  assert.equal(probe.checkpoint().mediaWrites, 0);
  for (const ttlMs of [0, -1, Number.NaN, 15 * 60 * 1000 + 1])
    await assert.rejects(createQuestHealthProbe({ port: 0, ttlMs }));
});
