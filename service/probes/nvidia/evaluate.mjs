/** Synthetic-only preregistered retrieval evaluation. Never reads production config or calls a provider. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evidenceSourceId } from '../../src/evidence-contract.ts';
import { MemoryRecall } from '../../src/memory/recall.ts';
export const model = 'nvidia/nemotron-3-embed-1b';
function record(itemId, label, statement, extra = {}) {
  const source = { packageId: 'ctx_synthetic_semantic', itemId };
  return {
    ...source,
    sourceId: evidenceSourceId(source),
    label,
    statement,
    kind: 'object',
    origin: 'model',
    disposition: 'context',
    verification: 'accepted',
    modelConfidence: 0.9,
    observationId: null,
    utteranceId: null,
    interpretationId: null,
    model: null,
    text: [],
    humanActions: [],
    ...extra,
  };
}
export const corpus = [
  record(
    'walk-en',
    'Desert walk',
    'I walked through rippled sand before noon. I did not ride any animal.',
    { origin: 'person', verification: 'authored', modelConfidence: null },
  ),
  record(
    'animal-corrected',
    'Dromedary',
    'The person corrected the animal name: a camel with one hump.',
    {
      verification: 'corrected',
      humanActions: [
        {
          eventId: 'synthetic-correction',
          op: 'relabel',
          at: '1970-01-01T00:00:00Z',
          utteranceId: null,
        },
      ],
    },
  ),
  record('walk-ko', '여행 메모', '저는 해 질 무렵 낙타를 타지 않고 사구를 걸었어요.', {
    origin: 'person',
    verification: 'authored',
    modelConfidence: null,
  }),
  record('tea', 'Tea', 'The visitor drank green tea at a quiet cafe.'),
  record('plant', '낙타풀', 'A plant label; its name does not identify an animal.'),
  record('boat', 'Boat', 'A boat crossed a blue lake.'),
  record('old-animal', 'Two-humped camel', 'The photograph appears to show a two-humped camel.'),
  record('known', 'Known word', 'The learner already knows the word desert.', {
    disposition: 'known',
  }),
  record('rejected', 'Camping', 'The person rejected the claim that they camped overnight.', {
    disposition: 'rejected',
  }),
  record('unselected', 'Private distractor', 'I rode a camel.', {
    packageId: 'ctx_synthetic_unselected',
    sourceId: evidenceSourceId({ packageId: 'ctx_synthetic_unselected', itemId: 'unselected' }),
  }),
];
export const queries = [
  { id: 'exact-en', text: 'Dromedary', expected: 'animal-corrected', group: 'same-language' },
  { id: 'exact-ko', text: '여행 메모', expected: 'walk-ko', group: 'same-language' },
  {
    id: 'animal-ko-to-en',
    text: '혹이 하나인 동물은 무엇인가요?',
    expected: 'animal-corrected',
    group: 'cross-language',
  },
  {
    id: 'walk-en-to-ko',
    text: 'Which note describes crossing dunes on foot at sunset instead of riding a camel?',
    expected: 'walk-ko',
    group: 'cross-language',
  },
  {
    id: 'negation-ko-to-en',
    text: '정오가 되기 전에 사막에서 동물을 타지 않고 걸었나요?',
    expected: 'walk-en',
    group: 'cross-language',
  },
  {
    id: 'tea-ko-to-en',
    text: '카페에서 어떤 차를 마셨나요?',
    expected: 'tea',
    group: 'cross-language',
  },
];
export function eligibleRecords() {
  return corpus.filter(
    (record) =>
      record.packageId === 'ctx_synthetic_semantic' &&
      record.itemId !== 'old-animal' &&
      record.disposition === 'context',
  );
}
export function requests() {
  const records = eligibleRecords();
  return {
    synthetic: true,
    model,
    endpoint: 'https://integrate.api.nvidia.com/v1/embeddings',
    passageSources: records.map((record) => record.sourceId),
    queryIds: queries.map((query) => query.id),
    bodies: [
      {
        model,
        input: records.map((record) => `${record.label}\n${record.statement}`),
        input_type: 'passage',
        encoding_format: 'float',
        truncate: 'NONE',
      },
      {
        model,
        input: queries.map((query) => query.text),
        input_type: 'query',
        encoding_format: 'float',
        truncate: 'NONE',
      },
    ],
  };
}
export function baseline() {
  const memory = new MemoryRecall(eligibleRecords());
  return queries.map((query) => ({
    id: query.id,
    group: query.group,
    expected: query.expected,
    ranked: memory.query(query.text).map((hit) => hit.evidence.itemId),
  }));
}
function unit(vector) {
  assert.equal(vector.length, 2048, 'Unexpected embedding dimension.');
  assert.ok(
    vector.every((value) => typeof value === 'number' && Number.isFinite(value)),
    'Non-finite embedding.',
  );
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  assert.ok(norm > 0, 'Zero embedding.');
  return vector.map((value) => value / norm);
}
export function evaluateVectors(receipt) {
  assert.equal(receipt.model, model);
  assert.equal(receipt.synthetic, true);
  const records = eligibleRecords();
  assert.deepEqual(
    receipt.passageSources,
    records.map((record) => record.sourceId),
    'Source selection/order mismatch.',
  );
  assert.deepEqual(
    receipt.queryIds,
    queries.map((query) => query.id),
    'Query order mismatch.',
  );
  assert.equal(receipt.passages.length, records.length);
  assert.equal(receipt.queries.length, queries.length);
  const passages = receipt.passages.map(unit);
  return queries.map((query, index) => {
    const vector = unit(receipt.queries[index]);
    const ranked = passages
      .map((passage, i) => ({
        itemId: records[i].itemId,
        score: passage.reduce((sum, value, j) => sum + value * vector[j], 0),
      }))
      .sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
    return {
      id: query.id,
      group: query.group,
      expected: query.expected,
      ranked: ranked.map((hit) => hit.itemId),
    };
  });
}
export function metrics(rows) {
  const score = (group) => {
    const selected = rows.filter((row) => !group || row.group === group);
    return {
      tasks: selected.length,
      recallAt1: selected.filter((row) => row.ranked[0] === row.expected).length / selected.length,
      recallAt3:
        selected.filter((row) => row.ranked.slice(0, 3).includes(row.expected)).length /
        selected.length,
    };
  };
  return {
    overall: score(),
    sameLanguage: score('same-language'),
    crossLanguage: score('cross-language'),
  };
}
if (import.meta.main) {
  if (process.argv[2] === '--requests') console.log(JSON.stringify(requests(), null, 2));
  else {
    const result = { synthetic: true, baseline: metrics(baseline()), providerMeasured: false };
    if (process.argv[2] === '--vectors') {
      const file = await readFile(process.argv[3], 'utf8');
      assert.ok(file.length < 4 * 1024 * 1024);
      result.importedRankings = evaluateVectors(JSON.parse(file));
      result.importedVectors = metrics(result.importedRankings);
    }
    console.log(JSON.stringify(result, null, 2));
  }
}
