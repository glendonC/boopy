import assert from 'node:assert/strict';
import { it } from 'node:test';
import { testBoopy } from '../testing.ts';
import { headsetApp } from './headset.ts';

it('health identifies Boopy and configured answer/voice capability without inference, speech or account claims', async () => {
  let calls = 0;
  const test = testBoopy({
    interpreter: {
      provider: 'meta-model-api',
      model: 'synthetic-model',
      interpret: async () => {
        calls++;
        throw new Error('must not interpret');
      },
    },
    speechOutput: {
      synthesize: async () => {
        calls++;
        throw new Error('must not synthesize');
      },
    },
  });
  const app = headsetApp(test.boopy, { logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      service: 'boopy',
      speechOutputAvailable: true,
      handoffPreparationAvailable: false,
      interpreter: { provider: 'meta-model-api', model: 'synthetic-model' },
      segmenter: null,
      liveScene: null,
    });
    assert.equal(calls, 0);
    assert.equal(test.journal.all().length, 0);
    assert.doesNotMatch(response.body, /account|delivered|authenticated|modelReady/);
  } finally {
    await app.close();
    test.journal.close();
  }
});
