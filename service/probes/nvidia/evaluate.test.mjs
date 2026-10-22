import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  baseline,
  eligibleRecords,
  evaluateVectors,
  metrics,
  model,
  queries,
  requests,
} from './evaluate.mjs';

test('baseline and synthetic requests never include excluded sources and preserve trust', () => {
  const records = eligibleRecords();
  assert.equal(records.length, 6);
  assert.ok(
    records.every(
      (record) => !['old-animal', 'known', 'rejected', 'unselected'].includes(record.itemId),
    ),
  );
  assert.ok(
    records.some((record) => record.verification === 'authored' && record.modelConfidence === null),
  );
  assert.equal(
    records.find((record) => record.itemId === 'animal-corrected').verification,
    'corrected',
  );
  const plan = requests();
  assert.equal(plan.bodies[0].input_type, 'passage');
  assert.equal(plan.bodies[1].input_type, 'query');
  assert.equal(plan.bodies[0].input.length, 6);
  assert.equal(plan.bodies[1].input.length, 6);
  assert.equal(metrics(baseline()).overall.tasks, 6);
});
test('imported embedding evaluation checks exact scope, dimensions and finite nonzero vectors', () => {
  const vector = Array.from({ length: 2048 }, (_, i) => (i === 0 ? 1 : 0));
  const receipt = {
    synthetic: true,
    model,
    passageSources: requests().passageSources,
    queryIds: queries.map((query) => query.id),
    passages: Array.from({ length: 6 }, () => [...vector]),
    queries: Array.from({ length: 6 }, () => [...vector]),
  };
  assert.equal(evaluateVectors(receipt).length, 6);
  assert.throws(
    () => evaluateVectors({ ...receipt, passageSources: [...receipt.passageSources].reverse() }),
    /selection/,
  );
  assert.throws(
    () => evaluateVectors({ ...receipt, passages: [[1], ...receipt.passages.slice(1)] }),
    /dimension/,
  );
  assert.throws(
    () =>
      evaluateVectors({ ...receipt, queries: [Array(2048).fill(0), ...receipt.queries.slice(1)] }),
    /Zero/,
  );
  assert.throws(
    () =>
      evaluateVectors({
        ...receipt,
        queries: [Array(2048).fill(NaN), ...receipt.queries.slice(1)],
      }),
    /finite/,
  );
});
