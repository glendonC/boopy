import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActivityStore } from '../activity.ts';
import { ActivityCalls } from '../activity-call.ts';
import { sha256 } from '../activity-contract.ts';
import type { HandoffPreparation } from '../handoff-preparation.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

async function setup(enabled = true) {
  const test = testBoopy();
  const session = await test.boopy.start(startRequest('Synthetic activity call route.'));
  const packageId = test.boopy.commit(session.id).committed?.packageId;
  assert.ok(packageId);
  const activities = new ActivityStore({
    journal: test.journal,
    packageForId: (id) => test.boopy.package(id),
    supersessions: () => test.boopy.supersessions,
    preparation: {
      forPackage: () =>
        ({
          sessionId: session.id,
          requestId: 'synthetic-prep',
          receiptId: 'synthetic-receipt',
          sourceState: 'unchanged',
          receipt: { packetSha256: sha256('Synthetic packet.') },
        }) as ReturnType<HandoffPreparation['forPackage']>,
      readPacket: async () => 'Synthetic packet.',
    },
  });
  const calls = new ActivityCalls({
    store: activities,
    assistant: {
      provider: 'ollama',
      model: 'qwen3.6:35b-a3b-nvfp4',
      ask: async () => ({ content: '{}', metrics: null }),
    },
  });
  const headset = headsetApp(test.boopy, {
    logger: false,
    activities,
    ...(enabled ? { activityCalls: calls } : {}),
  });
  const connector = connectorApp(test.boopy, {
    logger: false,
    token: 'synthetic-token',
    baseUrl: 'https://synthetic.invalid',
    handoff: {} as HandoffPreparation,
    activities,
    ...(enabled ? { activityCalls: calls } : {}),
  });
  const request = { packageId, goal: 'Synthetic practice.' };
  const native = (method: 'GET' | 'POST', url: string, payload?: unknown, headers = {}) =>
    headset.inject({
      method,
      url,
      headers: { host: '127.0.0.1', ...headers },
      ...(payload ? { payload: payload as object } : {}),
    });
  const local = (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers = {},
    remoteAddress = '127.0.0.1',
  ) =>
    connector.inject({
      method,
      url,
      remoteAddress,
      headers: { host: '127.0.0.1', authorization: 'Bearer synthetic-token', ...headers },
      ...(payload ? { payload: payload as object } : {}),
    });
  return {
    test,
    activities,
    calls,
    native,
    local,
    request,
    async close() {
      await calls.close(0);
      await headset.close();
      await connector.close();
      test.journal.close();
    },
  };
}

describe('activity call routes', () => {
  it('starts asynchronously, lists calls and reads literal call identifiers', async () => {
    const s = await setup();
    try {
      assert.deepEqual(
        (await s.native('GET', '/v1/health')).json().activityAssistant,
        s.calls.capability,
      );
      const start = await s.native('POST', '/v1/activities/practice-requests', s.request);
      assert.equal(start.statusCode, 202);
      const call = start.json();
      assert.equal(call.state, 'running');
      await s.calls.finished(call.callId);
      assert.equal(
        (await s.native('GET', `/v1/activity-calls/${call.callId}`)).json().state,
        'failed',
      );
      assert.equal((await s.native('GET', '/v1/activity-calls')).json().calls.length, 1);
      assert.equal(
        (await s.native('GET', `/v1/activity-calls/%63${call.callId.slice(1)}`)).statusCode,
        404,
      );
      assert.equal(
        (await s.native('GET', '/v1/activity-calls/cal_unknown')).json().error.code,
        'call_unknown',
      );
      const local = await s.local('POST', '/v1/local-activities/practice-requests', s.request);
      assert.equal(local.statusCode, 202);
      assert.equal(
        (await s.local('GET', `/v1/local-activities/calls/${local.json().callId}`)).statusCode,
        200,
      );
    } finally {
      await s.close();
    }
  });
  it('refuses browsers and nonlocal operators before a call or disclosure', async () => {
    const s = await setup();
    try {
      const count = s.test.journal.all().length;
      for (const [method, path] of [
        ['POST', '/v1/activities/practice-requests'],
        ['GET', '/v1/activity-calls'],
        ['GET', '/v1/activity-calls/cal_unknown'],
      ] as const)
        assert.equal(
          (
            await s.native(method, path, method === 'POST' ? s.request : undefined, {
              origin: 'http://localhost',
            })
          ).statusCode,
          403,
        );
      assert.equal(
        (
          await s.local('POST', '/v1/local-activities/practice-requests', s.request, {
            origin: 'http://localhost',
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await s.local(
            'POST',
            '/v1/local-activities/practice-requests',
            s.request,
            {},
            '192.0.2.1',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await s.local('POST', '/v1/local-activities/practice-requests', s.request, {
            authorization: 'Bearer wrong',
          })
        ).statusCode,
        401,
      );
      assert.equal(s.test.journal.all().length, count);
    } finally {
      await s.close();
    }
  });
  it('advertises no assistant and returns 503 when calls are disabled', async () => {
    const s = await setup(false);
    try {
      assert.equal('activityAssistant' in (await s.native('GET', '/v1/health')).json(), false);
      assert.equal(
        (await s.native('POST', '/v1/activities/practice-requests', s.request)).statusCode,
        503,
      );
      assert.equal(
        (await s.local('POST', '/v1/local-activities/practice-requests', s.request)).statusCode,
        503,
      );
    } finally {
      await s.close();
    }
  });
});
