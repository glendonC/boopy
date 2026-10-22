import assert from 'node:assert/strict';
import { it } from 'node:test';
import { localRehearsal } from './local-rehearsal.ts';

it('rehearses keyed conversation, targeted follow-up, save and authenticated connector readback', async () => {
  const report = await localRehearsal();
  assert.equal(report.passed, true);
  assert.equal(report.mode, 'synthetic-fixture');
  assert.equal(report.interpretationCalls, 2);
  assert.equal(report.answerRecords, 1);
  assert.deepEqual(report.authenticatedReadbacks, ['REST', 'MCP']);
  assert.equal(report.storage, 'in-memory');
});

it('can repeat with fresh isolated storage and closed connector resources', async () => {
  const first = await localRehearsal();
  const second = await localRehearsal();
  assert.deepEqual(second, first);
});
