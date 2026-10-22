import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { TaskTurn } from '../boopy.ts';
import type { Item } from '../contracts.ts';
import { standIn } from './stand-in.ts';

const SHA = 'c'.repeat(64);
const SESSION = 'ses_capture';
const IDS = { eventId: 'evt_open_capture', taskId: 'tsk_capture' };
const AT = '1970-01-01T18:00:04.000Z';

const referent: Item = {
  id: 'int_4.photo',
  kind: 'object',
  label: 'Desert photo',
  statement: 'A photo of a desert trip with dunes and camels.',
  grounding: { kind: 'box', observationId: 'obs_2', box: { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.7 } },
  confidence: 0.85,
  origin: 'model',
  status: 'proposed',
  emphasis: false,
  interpretationId: 'int_4',
};

const facts: TaskTurn = {
  turn: { utteranceId: 'utt_3', words: 'What is this?', observationId: 'obs_2', frameSha256: SHA },
  dialogue: { text: 'A desert photo with camels.', utteranceId: 'utt_3', at: AT },
  referent,
};

function components(plan: ReturnType<typeof standIn>) {
  return plan?.result.components.map((component) => component.type);
}

describe('local stand-in for a first completed turn', () => {
  it('projects the turn into one opening and one labeled result', () => {
    const plan = standIn(SESSION, IDS, facts);
    assert.ok(plan);
    const source = { sourceId: 'src_obs_2', sourceRevision: 1, sha256: SHA };
    assert.deepEqual(plan.open, {
      ...IDS,
      sessionId: SESSION,
      source,
      intent: 'consult_source',
      utterance: 'What is this?',
    });
    const digest = createHash('sha256').update(`${SESSION}:utt_3:${AT}`).digest('hex');
    assert.deepEqual(plan.result, {
      resultId: `res_${digest.slice(0, 32)}`,
      sessionId: SESSION,
      taskId: IDS.taskId,
      baseRevision: 0,
      source,
      evidenceIds: ['int_4.photo'],
      components: [
        { type: 'subject', sourceId: 'src_obs_2', maskId: null },
        { type: 'annotation', text: 'Desert photo', evidenceIds: ['int_4.photo'] },
        { type: 'dialogue', text: 'A desert photo with camels.', evidenceIds: ['int_4.photo'] },
        { type: 'voice_reply', prompt: 'Answer aloud.' },
      ],
    });
    assert.deepEqual(standIn(SESSION, IDS, facts), plan);
  });

  it('refuses a turn that is not ready instead of filling the gap', () => {
    const turn = facts.turn;
    const dialogue = facts.dialogue;
    assert.ok(turn && dialogue);
    const cases: [string, TaskTurn][] = [
      ['no visual turn', { ...facts, turn: null }],
      ['no reply', { ...facts, dialogue: null }],
      ['a reply to another turn', { ...facts, dialogue: { ...dialogue, utteranceId: 'utt_9' } }],
      ['no referent', { ...facts, referent: null }],
      ['a rejected referent', { ...facts, referent: { ...referent, status: 'rejected' } }],
      ['an ignored referent', { ...facts, referent: { ...referent, status: 'ignored' } }],
      [
        'a referent on another view',
        {
          ...facts,
          referent: { ...referent, grounding: { ...referent.grounding, observationId: 'obs_9' } },
        },
      ],
      [
        'a referent without a view',
        { ...facts, referent: { ...referent, grounding: { kind: 'scene' } } },
      ],
      [
        'a referent id that is not evidence',
        { ...facts, referent: { ...referent, id: 'int 4/photo' } },
      ],
      ['an unknown frame digest', { ...facts, turn: { ...turn, frameSha256: 'unknown' } }],
      ['words on two lines', { ...facts, turn: { ...turn, words: 'What is\nthis?' } }],
      ['words over 400 characters', { ...facts, turn: { ...turn, words: 'a'.repeat(401) } }],
      ['words that NFC would change', { ...facts, turn: { ...turn, words: 'Café?' } }],
      ['no words', { ...facts, turn: { ...turn, words: '' } }],
    ];
    for (const [name, value] of cases) assert.equal(standIn(SESSION, IDS, value), null, name);
    assert.equal(standIn('ses capture', IDS, facts), null);
    assert.ok(standIn(SESSION, IDS, { ...facts, turn: { ...turn, words: 'a'.repeat(400) } }));
    assert.ok(
      standIn(SESSION, IDS, {
        ...facts,
        referent: {
          ...referent,
          status: 'confirmed',
          grounding: { kind: 'scene', observationId: 'obs_2' },
        },
      }),
    );
  });

  it('omits a label or reply the display rules refuse, and never shortens or rewrites one', () => {
    const dialogue = facts.dialogue;
    assert.ok(dialogue);
    const long = 'A'.repeat(81);
    const cases: [string, TaskTurn, string[]][] = [
      [
        'a label over 80',
        { ...facts, referent: { ...referent, label: long } },
        ['subject', 'dialogue', 'voice_reply'],
      ],
      [
        'a label with markup',
        { ...facts, referent: { ...referent, label: '<b>Photo</b>' } },
        ['subject', 'dialogue', 'voice_reply'],
      ],
      [
        'a label that trimming changes',
        { ...facts, referent: { ...referent, label: ' Desert photo' } },
        ['subject', 'dialogue', 'voice_reply'],
      ],
      [
        'a reply over 200',
        { ...facts, dialogue: { ...dialogue, text: 'b'.repeat(201) } },
        ['subject', 'annotation', 'voice_reply'],
      ],
      [
        'a reply on two lines',
        { ...facts, dialogue: { ...dialogue, text: 'One.\nTwo.' } },
        ['subject', 'annotation', 'voice_reply'],
      ],
    ];
    for (const [name, value, types] of cases) {
      const plan = standIn(SESSION, IDS, value);
      assert.deepEqual(components(plan), types, name);
      const texts = JSON.stringify(plan?.result.components);
      assert.doesNotMatch(texts, /AAAA|bbbb|Photo<|One\./, name);
    }
    const exact = standIn(SESSION, IDS, {
      ...facts,
      referent: { ...referent, label: 'L'.repeat(80) },
      dialogue: { ...dialogue, text: 'd'.repeat(200) },
    });
    assert.deepEqual(components(exact), ['subject', 'annotation', 'dialogue', 'voice_reply']);
  });

  it('makes the observation id safe for a source id and keeps at most 64 characters of it', () => {
    const turn = facts.turn;
    assert.ok(turn);
    const at = (observationId: string) =>
      standIn(SESSION, IDS, {
        ...facts,
        turn: { ...turn, observationId },
        referent: { ...referent, grounding: { ...referent.grounding, observationId } },
      })?.open.source.sourceId;
    assert.equal(at('obs/1:2.3'), 'src_obs_1_2_3');
    assert.equal(at('o'.repeat(100)), `src_${'o'.repeat(64)}`);
  });
});
