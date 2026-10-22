import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeReceipt } from './receipt.mjs';

const success = {
  synthetic: true,
  outcome: 'passed',
  query: 'select-one',
  totalDeadlineMs: 20000,
  rows: 1,
  columns: 1,
  loginTimeoutConfigured: true,
  queryTimeoutConfigured: false,
  schemaCount: 0,
  driverVersion: 'synthetic-0.1',
};
test('producer success cannot override nonzero exit and arbitrary JSON fields never reach receipts', () => {
  assert.throws(() => probeReceipt(JSON.stringify(success), 1));
  assert.throws(() => probeReceipt(JSON.stringify(success), null));
  const extra = {
    ...success,
    password: 'synthetic-secret',
    error: 'private provider text',
    arbitrary: { nested: 'private' },
  };
  const receipt = probeReceipt(JSON.stringify(extra), 0);
  assert.deepEqual(receipt, success);
  assert.doesNotMatch(JSON.stringify(receipt), /secret|private|password|arbitrary/);
});
test('failure exit and bounded metadata remain consistent and sanitizable', () => {
  const failure = {
    synthetic: true,
    outcome: 'failed',
    query: 'select-one',
    totalDeadlineMs: 20000,
    stage: 'connect',
    errorClass: 'SQLException',
    failureKind: 'unclassified',
  };
  assert.deepEqual(probeReceipt(JSON.stringify(failure), 1), failure);
  assert.throws(() => probeReceipt(JSON.stringify(failure), 0));
  for (const mutated of [
    { ...success, schemaCount: 101 },
    { ...success, driverVersion: 'private message\n' },
    { ...success, rows: 10000 },
    { ...failure, failureKind: 'private arbitrary detail' },
  ])
    assert.throws(() =>
      probeReceipt(JSON.stringify(mutated), mutated.outcome === 'passed' ? 0 : 1),
    );
});
