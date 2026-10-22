import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type EvidenceRecord, evidenceSourceId, type Supersession } from '../evidence-contract.ts';
import { embed, tokenize } from './hmem/embeddings.ts';
import { MemoryStoreService } from './hmem/memoryStore.ts';
import { TrustLedgerService } from './hmem/trustLedger.ts';
import { MemoryRecall } from './recall.ts';

function evidence(packageId: string, itemId: string, statement: string): EvidenceRecord {
  return {
    packageId,
    itemId,
    sourceId: evidenceSourceId({ packageId, itemId }),
    statement,
    kind: 'object',
    label: 'Travel photo',
    origin: 'model',
    disposition: 'context',
    verification: 'accepted',
    modelConfidence: null,
    observationId: null,
    utteranceId: null,
    interpretationId: null,
    model: null,
    text: [],
    humanActions: [],
  };
}
function link(a: EvidenceRecord, b: EvidenceRecord): Supersession {
  return {
    eventId: 'synthetic-correction',
    at: '1970-01-01T00:00:00Z',
    predecessor: a,
    successor: b,
  };
}
function mustHit(recall: MemoryRecall, query: string) {
  const result = recall.query(query)[0];
  assert.ok(result);
  return result;
}
test('upstream correction hazard and exact-target later recall preserve same-label distractor', () => {
  const ledger = new TrustLedgerService(() => 0),
    store = new MemoryStoreService(() => 0, ledger, 'synthetic');
  const old = store.add({ content: 'Sahara travel photo tents', source: 'synthetic-a' });
  store.add({
    content: 'Correction Sahara travel photo camels',
    source: 'synthetic-b',
    supersedes: old.id,
  });
  assert.equal(old.supersededBy, undefined);
  const a = evidence('trip:a', 'photo', 'Sahara travel photo tents');
  const b = evidence('trip:b', 'photo', 'Sahara travel photo camels');
  b.origin = 'person';
  b.verification = 'corrected';
  b.humanActions = [
    { eventId: 'action-b', op: 'relabel', at: '1970-01-01T00:00:00Z', utteranceId: null },
  ];
  const distractor = evidence('other-trip', 'photo', 'Sahara travel photo tents');
  const recall = new MemoryRecall([a, b, distractor], [link(a, b)]);
  const hits = recall.query('Sahara travel photo', { threshold: 0 });
  assert.equal(
    hits.some((hit) => hit.evidence.sourceId === a.sourceId),
    false,
  );
  assert.equal(
    hits.some((hit) => hit.evidence.sourceId === distractor.sourceId),
    true,
  );
  assert.deepEqual(hits.find((hit) => hit.evidence.sourceId === b.sourceId)?.evidence, b);
});
test('duplicates, trust/null preservation, query replay and optional disable', () => {
  const a = evidence('trip', 'a', 'Sahara camel travel photo');
  a.modelConfidence = 1;
  const b = evidence('trip', 'b', 'unknown travel photo');
  const recall = new MemoryRecall([a, a, b]);
  a.verification = 'confirmed';
  const first = recall.query('Sahara camel', { threshold: 0 });
  assert.equal(first.length, 2);
  const hit = mustHit(recall, 'Sahara camel');
  assert.equal(hit.evidence.verification, 'accepted');
  assert.equal(hit.evidence.modelConfidence, 1);
  hit.evidence.verification = 'confirmed';
  assert.equal(mustHit(recall, 'Sahara camel').evidence.verification, 'accepted');
  assert.equal(first.find((item) => item.evidence.itemId === 'b')?.evidence.modelConfidence, null);
  assert.deepEqual(recall.query('Sahara camel', { enabled: false }), []);
});
test('duplicate conflicts, unknown/cyclic/forked targets and link replay', () => {
  const a = evidence('trip', 'a', 'one'),
    b = evidence('trip', 'b', 'two'),
    c = evidence('trip', 'c', 'three');
  assert.throws(() => new MemoryRecall([a, { ...a, statement: 'different' }]), /duplicate/);
  assert.throws(() => new MemoryRecall([a], [link(a, b)]), /Unknown/);
  assert.throws(() => new MemoryRecall([a, b], [link(a, b), link(b, a)]), /Cyclic/);
  assert.throws(() => new MemoryRecall([a, b, c], [link(a, b), link(a, c)]), /successors/);
  const forward = new MemoryRecall([a, b, c], [link(a, b), link(b, c)]).query('three', {
    threshold: 0,
  });
  const reverse = new MemoryRecall([c, b, a], [link(b, c), link(a, b)]).query('three', {
    threshold: 0,
  });
  assert.deepEqual(forward, reverse);
  assert.equal(forward[0]?.evidence.sourceId, c.sourceId);
  assert.equal(
    new MemoryRecall([a, b, c], [link(a, c), link(b, c)]).query('three', { threshold: 0 }).length,
    1,
  );
});
test('Korean lexical regression and English distractors are separate from semantic quality', () => {
  assert.deepEqual(tokenize('사하라 여행 낙타'), ['사하라', '여행', '낙타']);
  assert.equal(embed('사하라 여행 낙타').some(Boolean), true);
  const korean = evidence('trip', 'ko', '사하라 여행 낙타'),
    english = evidence('trip', 'en', 'Sahara travel camel');
  const recall = new MemoryRecall([
    korean,
    english,
    evidence('trip', 'noise', 'unrelated database invoice'),
  ]);
  assert.equal(mustHit(recall, '사하라 여행 낙타').evidence.sourceId, korean.sourceId);
  assert.equal(mustHit(recall, 'Sahara travel camel').evidence.sourceId, english.sourceId);
  assert.throws(() => recall.query('camel', { topN: Infinity }), /bounds/);
});

test('human note corrections and rejection reasons remain verbatim in retrieved evidence', () => {
  const original = evidence('trip', 'original', 'A travel photo');
  const correction = evidence('trip', 'correction', 'A travel photo');
  correction.verification = 'corrected';
  correction.note = 'Learn the caravan greeting before practicing directions.';
  correction.humanActions = [
    { eventId: 'synthetic-note', op: 'note', at: '1970-01-01T00:00:00Z', utteranceId: null },
  ];
  const rejected = evidence('trip', 'rejected', 'A travel photo');
  rejected.disposition = 'rejected';
  rejected.verification = 'unconfirmed';
  rejected.note = 'Rejected because the claimed Marrakech location is unsupported.';
  const recall = new MemoryRecall([original, correction, rejected], [link(original, correction)]);
  const hit = mustHit(recall, 'caravan greeting practicing directions');
  assert.equal(hit.evidence.sourceId, correction.sourceId);
  assert.equal(hit.evidence.note, correction.note);
  assert.deepEqual(hit.evidence.humanActions, correction.humanActions);
  const rejection = mustHit(recall, 'Marrakech location unsupported');
  assert.equal(rejection.evidence.sourceId, rejected.sourceId);
  assert.equal(rejection.evidence.note, rejected.note);
  assert.equal(rejection.evidence.disposition, 'rejected');
  assert.equal(rejection.evidence.verification, 'unconfirmed');
});

test('exact named Korean gloss survives long bilingual evidence without matching substrings or unrelated personal text', () => {
  const old = evidence('old', 'camel', 'Camels in a photo');
  old.gloss = '낙타';
  const corrected = evidence(
    'new',
    'camel',
    `The person named this dromedary; the earlier model proposed Camels. ${'Long unrelated bilingual provenance detail. '.repeat(18)}`,
  );
  corrected.label = 'Dromedary';
  corrected.gloss = '낙타';
  corrected.verification = 'corrected';
  corrected.humanActions = [
    { eventId: 'synthetic-name', op: 'relabel', at: '1970-01-01T00:00:00Z', utteranceId: null },
  ];
  const near = evidence('other', 'plant', 'A plant label, not an animal');
  near.label = '낙타풀';
  const personal = evidence('other', 'personal', 'Long personal sailing story. '.repeat(20));
  personal.label = '돛단배';
  personal.origin = 'person';
  personal.modelConfidence = null;
  const statementOnly = evidence(
    'other',
    'mention',
    `낙타 appears incidentally. ${'Unrelated invoice details. '.repeat(30)}`,
  );
  statementOnly.label = 'Invoice';
  const corpus = [old, corrected, near, personal, statementOnly];
  const recall = new MemoryRecall(corpus, [link(old, corrected)]);
  assert.equal(
    recall
      .query('낙타', { threshold: 0.35 })
      .some((hit) => hit.evidence.sourceId === corrected.sourceId),
    false,
    'The fixture must reproduce reference-score dilution.',
  );
  for (const query of ['낙타', '사하라 여행 낙타', 'Dromedary']) {
    const hits = recall.query(query);
    assert.equal(hits[0]?.evidence.sourceId, corrected.sourceId);
    assert.deepEqual(hits[0]?.evidence, corrected);
    assert.equal(
      hits.some((hit) =>
        [old.sourceId, near.sourceId, personal.sourceId, statementOnly.sourceId].includes(
          hit.evidence.sourceId,
        ),
      ),
      false,
    );
    assert.ok(
      (hits[0]?.relevance ?? 1) < 0.35,
      'Exact-term recovery must not inflate the actual H-MEM score.',
    );
  }
  const sailing = recall.query('돛단배');
  assert.equal(sailing[0]?.evidence.sourceId, personal.sourceId);
  assert.equal(sailing[0]?.evidence.modelConfidence, null);
  assert.deepEqual(recall.query('기차역'), []);
});

test('semantic override replaces only cosine without altering evidence or retrieval confidence', () => {
  const record = evidence('synthetic', 'source', 'Synthetic dune account');
  const recall = new MemoryRecall([record]);
  const low = recall.query('unrelated query', {
    threshold: 0,
    semanticScores: new Map([[record.sourceId, -1]]),
  })[0];
  const high = recall.query('unrelated query', {
    threshold: 0,
    semanticScores: new Map([[record.sourceId, 1]]),
  })[0];
  assert.ok(low && high);
  assert.ok(Math.abs(high.relevance - low.relevance - 0.35) < 1e-12);
  assert.equal(high.retrievalConfidence, low.retrievalConfidence);
  assert.deepEqual(high.evidence, low.evidence);
  for (const [id, score] of [
    [record.sourceId, 1.1],
    ['unselected', 0.4],
    [record.sourceId, Number.NaN],
  ] as [string, number][])
    assert.throws(() => recall.query('query', { semanticScores: new Map([[id, score]]) }));
});

test('a corrected camel-ride claim does not resurface, and a speaking attempt is not that claim', () => {
  const ride = evidence('sahara', 'ride', 'The person rode a camel in this picture.');
  ride.origin = 'model';
  ride.verification = 'unconfirmed';
  ride.modelConfidence = 0.9;
  ride.disposition = 'context';
  const denial = evidence(
    'sahara',
    'denial',
    'A camel is in this picture. The person did not ride it.',
  );
  denial.origin = 'person';
  denial.verification = 'authored';
  denial.modelConfidence = null;
  denial.disposition = 'known';
  denial.humanActions = [
    {
      eventId: 'evt_ride_correction',
      op: 'note',
      at: '',
      utteranceId: null,
    },
  ];
  const attempt = evidence('sahara', 'attempt', '낙타가 있어요');
  attempt.origin = 'person';
  attempt.verification = 'authored';
  attempt.modelConfidence = null;
  attempt.kind = 'practice-attempt';
  attempt.label = 'Korean speaking attempt';
  attempt.disposition = 'question';
  const original = ride.statement;
  const recall = new MemoryRecall([ride, denial, attempt], [link(ride, denial)]);
  assert.throws(
    () => recall.query('rode a camel', { semanticScores: new Map([[ride.sourceId, 1]]) }),
    /semantic/,
  );
  const hits = recall.query('The person rode a camel in this picture.');
  assert.equal(
    hits.some((hit) => hit.evidence.sourceId === ride.sourceId),
    false,
  );
  assert.equal(hits[0]?.evidence.sourceId, denial.sourceId);
  assert.equal(
    hits.some((hit) => hit.evidence.sourceId === attempt.sourceId),
    false,
  );
  assert.equal(ride.statement, original);
  assert.equal(denial.statement, 'A camel is in this picture. The person did not ride it.');
  assert.equal(attempt.kind, 'practice-attempt');
  assert.notEqual(attempt.verification, 'confirmed');
});
