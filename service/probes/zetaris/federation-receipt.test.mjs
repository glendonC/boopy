import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceRecordHash, federationReceipt } from './federation-receipt.mjs';

const row = {
  sourceId: 'ctx_13:itm_11',
  packageId: 'ctx_13',
  evidenceId: 'itm_11',
  revisionId: null,
  capturedAt: null,
  humanVerification: 'authored',
  disposition: 'context',
  modelConfidence: null,
  referenceSourceId: 'wikidata:Q25391',
  referenceId: 'Q25391',
  koreanTerm: '사구',
  englishGloss: 'dune',
  referenceVersion: '2546278779',
  updatedAt: '1970-01-01T16:49:42Z',
  referenceStatus: 'external-unreviewed',
  referenceUrl: 'https://www.wikidata.org/wiki/Q25391',
  license: 'CC0-1.0',
  sourceRecordSha256: 'a'.repeat(64),
  conceptKey: 'dune',
};
const receipt = (rows) =>
  JSON.stringify({ syntheticContext: true, outcome: 'passed', result: { mode: 'join', rows } });
test('runtime receipt preserves authored source and unknown associations separately from reference', () => {
  const result = federationReceipt(
    receipt([{ ...row, arbitraryDriverSecret: 'synthetic-private' }]),
    0,
    'join',
  );
  assert.deepEqual(result.rows, [row]);
  assert.equal(result.mode, 'zetaris-runtime');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|arbitraryDriverSecret/);
});
test('contradictory exits, broken identity, excluded disposition and invented attribution cannot pass', () => {
  assert.throws(() => federationReceipt(receipt([row]), 1, 'join'));
  for (const patch of [
    { sourceId: 'ctx_other:itm_11' },
    { disposition: 'known' },
    { disposition: 'rejected' },
    { referenceUrl: 'https://wrong.example' },
    { license: 'guessed' },
    { referenceStatus: 'verified' },
    { modelConfidence: 1.1 },
    { capturedAt: undefined },
    { koreanTerm: 'bad\nfield' },
  ])
    assert.throws(() => federationReceipt(receipt([{ ...row, ...patch }]), 0, 'join'));
});
test('reference changes remain distinct and diagnostics are strictly allowlisted', () => {
  const changed = federationReceipt(
    receipt([{ ...row, referenceVersion: '2546278778' }]),
    0,
    'join',
  );
  assert.equal(changed.rows[0].humanVerification, 'authored');
  assert.equal(changed.rows[0].modelConfidence, null);
  const failed = {
    syntheticContext: true,
    outcome: 'failed',
    stage: 'register-table',
    errorClass: 'SQLException',
    failureKind: 'syntax',
    raw: 'synthetic-private',
  };
  const failure = federationReceipt(JSON.stringify(failed), 1, 'register');
  assert.equal(failure.outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(failure), /raw|synthetic-private/);
  assert.throws(() =>
    federationReceipt(JSON.stringify({ ...failed, failureKind: 'secret' }), 1, 'register'),
  );
  assert.throws(() => federationReceipt(receipt(Array.from({ length: 11 }, () => row)), 0, 'join'));
});

test('full-record binding survives object key order but changes with authored content', () => {
  assert.equal(
    evidenceRecordHash({ sourceId: 'a:b', statement: 'Synthetic A', modelConfidence: null }),
    evidenceRecordHash({ modelConfidence: null, statement: 'Synthetic A', sourceId: 'a:b' }),
  );
  assert.notEqual(
    evidenceRecordHash({ sourceId: 'a:b', statement: 'Synthetic A' }),
    evidenceRecordHash({ sourceId: 'a:b', statement: 'Synthetic B' }),
  );
});
