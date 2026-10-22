import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runMusePreflight } from './muse-probe.ts';

it('proves local fetch and trust boundaries without implying consumer Muse success', async () => {
  const result = await runMusePreflight();
  assert.equal(result.restFetch, 'passed');
  assert.equal(result.mcpFetch, 'passed');
  assert.equal(result.fullFetchDisclosures, 2);
  assert.equal(result.verificationPreserved, 'passed');
  assert.equal(result.unauthorizedReads, 'denied');
  assert.equal(result.actualMuse, 'unverified');
  assert.equal(result.scheduling, 'unverified');
  assert.equal(result.mediaDelivery, 'unverified');
  assert.doesNotMatch(JSON.stringify(result), /token|Desert|Korean/);
});
