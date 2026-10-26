import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TraceRow, traceLines } from './trace.ts';

const SAID = 'What is this synthetic secret question?';
const HEARD = '합성어 synthetic transcript';
const rows: TraceRow[] = [
  {
    type: 'utterance.heard',
    session: 'ses_1',
    actor: 'person',
    at: '1970-01-01T00:00:00.000Z',
    id: 'evt_u',
    data: { utteranceId: 'utt_1', text: SAID, audioSha256: null },
  },
  {
    type: 'observation.recorded',
    session: 'ses_1',
    actor: 'person',
    at: '1970-01-01T00:00:00.000Z',
    id: 'evt_o',
    data: {
      observationId: 'obs_1',
      frameSha256: 'f'.repeat(64),
      recorded: {
        recordingId: 'rec_1',
        frameId: 'frm_4',
        path: 'footage/clip.MOV',
      },
    },
  },
  {
    type: 'interpretation.proposed',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:01.000Z',
    id: 'evt_i',
    data: {
      provider: 'ollama',
      model: 'synthetic-model',
      latencyMs: 1200,
      referentId: 'int_1.animal',
      items: [
        {
          id: 'int_1.animal',
          label: 'synthetic animal',
          confidence: 0.8,
          text: ['OCR synthetic sign'],
        },
      ],
    },
  },
  {
    type: 'task.opened',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:02.000Z',
    id: 'evt_open',
    data: { taskId: 'tsk_1', source: { sourceId: 'src_obs_1' }, utterance: SAID },
  },
  {
    type: 'task.reference-retrieved',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:02.000Z',
    id: 'ret_1',
    data: {
      taskId: 'tsk_1',
      queryId: 'term-pick-v1',
      engine: 'zetaris-local',
      status: 'external-unreviewed',
      guess: 'synthetic animal',
      targetLanguage: 'ko',
      outcome: 'passed',
      reason: 'term',
      phase: null,
      elapsedMs: 1800,
      stageMs: 300,
      pickMs: 670,
      practice: { tableRows: 1, journalRows: 1, restaged: false },
      memory: {
        hits: [{ sourceId: 'practice%3Atsk_0:evt_0', relevance: 0.42 }],
        recalled: ['Q7375'],
        excluded: 0,
      },
      rows: [
        {
          referenceId: 'Q7375',
          matched: 'subject',
          term: '합성어',
          gloss: null,
          matchedText: 'synthetic animal',
          revisionId: '101',
          retrievedAt: '1970-01-01T00:00:00.000Z',
          license: 'CC0-1.0',
          status: 'external-unreviewed',
          attempts: 1,
          notHeard: 1,
          lastResult: 'not-heard',
          why: 'not-heard-before',
        },
      ],
      decision: { referenceId: 'Q7375', why: 'not-heard-before', recalledReferenceId: null },
    },
  },
  {
    type: 'task.provider-accepted',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:02.000Z',
    id: 'res_1',
    data: {
      taskId: 'tsk_1',
      revision: 1,
      components: [
        { type: 'dialogue', text: "Last time I didn't hear 합성어 from you. Try it again?" },
      ],
    },
  },
  {
    type: 'task.action-accepted',
    session: 'ses_1',
    actor: 'person',
    at: '1970-01-01T00:00:03.000Z',
    id: 'evt_answer',
    data: {
      taskId: 'tsk_1',
      revision: 2,
      action: {
        type: 'voice_reply',
        text: HEARD,
        audioSha256: 'a'.repeat(64),
        recognizer: 'whisper',
      },
    },
  },
  {
    type: 'task.answer-assessed',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:03.000Z',
    id: 'asm_answer',
    data: {
      taskId: 'tsk_1',
      term: '합성어',
      result: 'heard',
      recognitionUncertain: true,
      method: 'term-in-recognized-text-v1',
    },
  },
  {
    type: 'task.provider-accepted',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:03.000Z',
    id: 'res_2',
    data: {
      taskId: 'tsk_1',
      revision: 3,
      components: [{ type: 'dialogue', text: `I heard ${HEARD}.` }],
    },
  },
  {
    type: 'task.practice-staged',
    session: 'ses_1',
    actor: 'system',
    at: '1970-01-01T00:00:04.000Z',
    id: 'stg_answer',
    data: {
      taskId: 'tsk_1',
      outcome: 'passed',
      phase: null,
      practice: { tableRows: 1, journalRows: 2, restaged: true },
      elapsedMs: 1300,
    },
  },
];

test('the trace walks observe, evidence, retrieve, decide, act and update from the journal', () => {
  const text = traceLines(rows, 'ses_1').join('\n');
  for (const step of ['observe', 'evidence', 'retrieve', 'decide', 'act', 'update'])
    assert.match(text, new RegExp(`^${step} `, 'm'));
  assert.match(text, /recorded footage/);
  assert.match(text, /synthetic animal/);
  assert.match(text, /term-pick-v1/);
  assert.match(text, /Q7375 subject 합성어 \(ko\)/);
  assert.match(text, /not-heard-before/);
  assert.match(text, /H-MEM/);
  assert.match(text, /Boopy heard: heard/);
  assert.match(text, /not sent to your AI/);
});

test("the trace never prints the person's words, a transcript, OCR text, a path or a frame", () => {
  const text = traceLines(rows, 'ses_1').join('\n');
  assert.doesNotMatch(
    text,
    /secret question|synthetic transcript|OCR synthetic|footage\/clip\.MOV/,
  );
  assert.doesNotMatch(text, /f{64}|a{64}/);
  assert.match(text, /withheld/);
  assert.deepEqual(traceLines(rows, 'ses_other'), ['No events for this session.']);
});

test("Boopy's lines still show when the person said only the term or the guess", () => {
  const said = rows.map((row) =>
    row.type === 'task.action-accepted'
      ? {
          ...row,
          data: {
            ...(row.data as object),
            action: { type: 'voice_reply', text: '합성어', audioSha256: 'a'.repeat(64) },
          },
        }
      : row.type === 'utterance.heard'
        ? { ...row, data: { ...(row.data as object), text: 'synthetic animal?' } }
        : row.type === 'task.provider-accepted' && (row.data as { revision: number }).revision === 3
          ? {
              ...row,
              data: {
                ...(row.data as object),
                components: [{ type: 'dialogue', text: 'I heard 합성어.' }],
              },
            }
          : row,
  );
  const text = traceLines(said, 'ses_1').join('\n');
  assert.match(text, /"I heard 합성어\."/);
  assert.match(text, /"Last time I didn't hear 합성어 from you\. Try it again\?"/);
  assert.doesNotMatch(text, /withheld/);
});
