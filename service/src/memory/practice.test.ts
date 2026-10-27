import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PracticeRecord } from '../interaction/tasks.ts';
import { practiceRows, recallPractice } from './practice.ts';

const record = (
  task: string,
  guess: string,
  term: string,
  referenceId: string,
  sourceId: string,
  result: PracticeRecord['result'],
  excluded = false,
): PracticeRecord => ({
  attemptEventId: `evt_${task}`,
  taskId: `tsk_${task}`,
  sessionId: 'sess_synthetic',
  sourceId,
  referenceId,
  language: 'ko',
  term,
  guess,
  result,
  at: `1970-01-01T00:00:0${task.length % 10}.000Z`,
  excluded,
  recordingId: null,
});
const records = [
  record('a', 'synthanimal', '합성동물', 'Q7375', 'src_obs_first', 'not-heard'),
  record('b', 'synthhill', '합성언덕', 'Q25391', 'src_obs_second', 'heard'),
  record('c', 'synthshelter', '합성천막', 'Q170544', 'src_obs_third', 'heard'),
];

test('earlier practice comes back for the same guess or the same source, and nothing else', () => {
  const sameSource = recallPractice(records, {
    guess: 'synthvehicle',
    sourceId: 'src_obs_first',
    recordingId: null,
  });
  assert.deepEqual(sameSource.recalled, ['Q7375']);
  const sameGuess = recallPractice(records, {
    guess: 'synthanimal',
    sourceId: 'src_obs_other',
    recordingId: null,
  });
  assert.deepEqual(sameGuess.recalled, ['Q7375']);
  assert.deepEqual(
    recallPractice(records, {
      guess: 'unrelated thing',
      sourceId: 'src_obs_other',
      recordingId: null,
    }).recalled,
    [],
  );
  for (const hit of sameSource.hits) assert.ok(Number.isFinite(hit.relevance));
});

test('practice on a subject the person marked wrong never comes back', () => {
  const marked = records.map((entry) =>
    entry.taskId === 'tsk_a' ? { ...entry, excluded: true } : entry,
  );
  assert.deepEqual(
    recallPractice(marked, { guess: 'synthanimal', sourceId: 'src_obs_first', recordingId: null })
      .recalled,
    [],
  );
  assert.equal(
    practiceRows(marked).some((row) => row.taskId === 'tsk_a'),
    false,
  );
  assert.deepEqual(
    practiceRows(records).map((row) => [row.attemptId, row.result, row.recognitionUncertain]),
    [
      ['evt_a', 'not-heard', true],
      ['evt_b', 'heard', true],
      ['evt_c', 'heard', true],
    ],
  );
});

test('the practice index is its own: no record text beyond the guess, the term and the source', () => {
  const { hits } = recallPractice(records, {
    guess: 'synthanimal',
    sourceId: 'src_obs_first',
    recordingId: null,
  });
  assert.deepEqual(
    hits.map((hit) => hit.sourceId),
    ['practice%3Atsk_a:evt_a'],
  );
  assert.equal(
    recallPractice([], { guess: 'synthanimal', sourceId: 'src_obs_first', recordingId: null }).hits
      .length,
    0,
  );
  assert.equal(
    recallPractice(records, { guess: '', sourceId: 'src_obs_none', recordingId: null }).recalled
      .length,
    0,
  );
});

test('on recorded footage, any boop on the same recording recalls its earlier practice', () => {
  const tents: PracticeRecord = {
    ...record('t', 'synthshelter', '합성천막', 'Q170544', 'src_obs_tents', 'heard'),
    recordingId: 'rec_camp',
  };
  // The sky in the same footage is its own observation, on the same recording.
  const sky = { guess: 'synthsky', sourceId: 'src_obs_sky', recordingId: 'rec_camp' };
  assert.deepEqual(recallPractice([tents], sky).recalled, ['Q170544']);
  // Another recording recalls nothing.
  assert.deepEqual(
    recallPractice([tents], { ...sky, sourceId: 'src_obs_dune', recordingId: 'rec_other' })
      .recalled,
    [],
  );
  // Practice on a subject the person marked wrong stays out, on the recording too.
  assert.deepEqual(recallPractice([{ ...tents, excluded: true }], sky).recalled, []);
});

test('a live observation keeps its own source key', () => {
  const live = record('l', 'synthshelter', '합성천막', 'Q170544', 'src_obs_live', 'heard');
  const query = { guess: 'synthsky', sourceId: 'src_obs_live', recordingId: null };
  assert.deepEqual(recallPractice([live], query).recalled, ['Q170544']);
  assert.deepEqual(recallPractice([live], { ...query, sourceId: 'src_obs_later' }).recalled, []);
  // A recorded boop never reaches live practice through its recording.
  assert.deepEqual(
    recallPractice([live], { ...query, sourceId: 'src_obs_later', recordingId: 'rec_camp' })
      .recalled,
    [],
  );
});
