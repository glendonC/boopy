import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import type { TaskTurn } from '../boopy.ts';
import type { Item } from '../contracts.ts';
import type { PickedRow } from '../references/zetaris.ts';
import { ProviderResult, type TaskView } from './contract.ts';
import { correctionResult, type PracticePick, practiceResult, standIn } from './stand-in.ts';

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
  dialogue: { text: 'A desert photo with camels.', utteranceId: 'utt_3', at: AT, choice: false },
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
      ],
    });
    assert.deepEqual(standIn(SESSION, IDS, facts), plan);
  });

  it("offers an answer only when Boopy's line asks the person something", () => {
    const dialogue = facts.dialogue;
    assert.ok(dialogue);
    const reply = (text: string) =>
      standIn(SESSION, IDS, { ...facts, dialogue: { ...dialogue, text } });
    for (const text of [
      'Is it a camel?',
      '이게 낙타예요?',
      '이게 뭐예요？',
      'Did you say "camel?"',
      'Is it (the camel?)',
      'A camel‽',
    ]) {
      const parts = reply(text)?.result.components;
      assert.deepEqual(components(reply(text)), [
        'subject',
        'annotation',
        'dialogue',
        'voice_reply',
      ]);
      assert.deepEqual(parts?.at(-1), { type: 'voice_reply', prompt: 'Answer.' }, text);
    }
    for (const text of [
      'A desert photo with camels.',
      'Is it a camel? It looks like one.',
      'A camel!',
      'It may be a camel',
    ])
      assert.deepEqual(components(reply(text)), ['subject', 'annotation', 'dialogue'], text);
  });

  it('refuses a turn that is not ready instead of filling the gap', () => {
    const turn = facts.turn;
    const dialogue = facts.dialogue;
    assert.ok(turn && dialogue);
    const cases: [string, TaskTurn][] = [
      ['no visual turn', { ...facts, turn: null }],
      ['no reply', { ...facts, dialogue: null }],
      ['a reply to another turn', { ...facts, dialogue: { ...dialogue, utteranceId: 'utt_9' } }],
      ['a reply with a choice card', { ...facts, dialogue: { ...dialogue, choice: true } }],
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
      // A boop with no words is exactly "", which opens a task; blank words are not.
      ['blank words', { ...facts, turn: { ...turn, words: '   ' } }],
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
        ['subject', 'dialogue'],
      ],
      [
        'a label with markup',
        { ...facts, referent: { ...referent, label: '<b>Photo</b>' } },
        ['subject', 'dialogue'],
      ],
      [
        'a label that trimming changes',
        { ...facts, referent: { ...referent, label: ' Desert photo' } },
        ['subject', 'dialogue'],
      ],
    ];
    for (const [name, value, types] of cases) {
      const plan = standIn(SESSION, IDS, value);
      assert.deepEqual(components(plan), types, name);
      assert.doesNotMatch(JSON.stringify(plan?.result.components), /AAAA|Photo</, name);
    }
    // Without Boopy's line there is nothing to answer, so nothing is offered and no task opens.
    for (const text of [`${'b'.repeat(200)}?`, 'One?\nTwo?'])
      assert.equal(
        standIn(SESSION, IDS, { ...facts, dialogue: { ...dialogue, text } }),
        null,
        text,
      );
    const exact = standIn(SESSION, IDS, {
      ...facts,
      referent: { ...referent, label: 'L'.repeat(80) },
      dialogue: { ...dialogue, text: `${'d'.repeat(199)}?` },
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

describe('the stand-in under a practice goal', () => {
  const animal: Item = { ...referent, label: 'synthetic animal' };
  const plan = standIn(SESSION, IDS, { ...facts, referent: animal });
  const row = (overrides: Partial<PickedRow> = {}): PickedRow => ({
    referenceId: 'Q7375',
    matched: 'subject',
    matchedText: 'synthetic animal',
    term: '합성어',
    gloss: null,
    description: null,
    referenceSourceId: 'wikidata:Q7375',
    revisionId: '101',
    modifiedAt: '1970-01-01T00:00:00Z',
    retrievedAt: '1970-01-01T00:00:02.000Z',
    referenceUrl: 'https://www.wikidata.org/wiki/Q7375',
    license: 'CC0-1.0',
    status: 'external-unreviewed',
    attempts: 0,
    notHeard: 0,
    onSource: 0,
    lastAt: null,
    lastResult: null,
    why: 'new',
    ...overrides,
  });
  const practise = (pick: PracticePick) => {
    assert.ok(plan);
    return practiceResult(plan, { language: 'ko', languageName: 'Korean', pick, confidence: 0.85 });
  };
  const line = (result: { components: readonly { type: string; text?: string }[] }) =>
    result.components.find((part) => part.type === 'dialogue')?.text;

  it("names the source's word beside Boopy's guess, with its source in the detail", () => {
    const practised = practise({ status: 'passed', rows: [row()] });
    assert.equal(practised.reason, 'term');
    assert.equal(practised.referenceId, 'Q7375');
    assert.deepEqual(practised.result.components, [
      { type: 'subject', sourceId: 'src_obs_2', maskId: null },
      { type: 'annotation', text: 'synthetic animal', evidenceIds: ['int_4.photo'] },
      {
        type: 'term',
        text: '합성어',
        language: 'ko',
        gloss: 'synthetic animal',
        sourceId: 'wikidata:Q7375',
        revision: '101',
        retrievedAt: '1970-01-01T00:00:02.000Z',
        license: 'CC0-1.0',
        via: 'zetaris-local',
        reviewed: false,
        notHeardLastTime: false,
        heardLastTime: false,
      },
      {
        type: 'dialogue',
        text: "Synthetic animal, I think. In Korean, that's 합성어. Can you say it?",
        evidenceIds: ['int_4.photo', 'wikidata:Q7375.ko'],
      },
      { type: 'voice_reply', prompt: 'Answer.' },
      {
        type: 'detail',
        text: 'Wikidata · Zetaris',
      },
    ]);
    assert.deepEqual(practised.result.evidenceIds, ['int_4.photo', 'wikidata:Q7375.ko']);
    assert.equal(ProviderResult.safeParse(practised.result).success, true);
    assert.equal(practised.result.resultId, plan?.result.resultId);
  });

  it('says it heard the word last time when this subject was heard, sure or unsure', () => {
    const heard = row({ attempts: 1, lastResult: 'heard', why: 'heard-before' });
    const again = practise({ status: 'passed', rows: [heard] });
    assert.equal(
      line(again.result),
      'Synthetic animal, I think. Last time I heard 합성어. Can you say it again?',
    );
    const marked = again.result.components.find((part) => part.type === 'term');
    assert.equal(marked?.type === 'term' && marked.heardLastTime, true);
    assert.equal(marked?.type === 'term' && marked.notHeardLastTime, false);
    assert.ok(again.result.components.some((part) => part.type === 'voice_reply'));
    assert.ok(plan);
    for (const confidence of [null, 0.3]) {
      const unsure = practiceResult(plan, {
        language: 'ko',
        languageName: 'Korean',
        pick: { status: 'passed', rows: [heard] },
        confidence,
      });
      assert.equal(
        line(unsure.result),
        "Synthetic animal? I'm not sure. Last time I heard 합성어. Can you say it again?",
      );
    }
  });

  it('asks again when this subject was not heard last time, and keeps other practice off the subject', () => {
    const again = practise({
      status: 'passed',
      rows: [row({ attempts: 1, notHeard: 1, lastResult: 'not-heard', why: 'not-heard-before' })],
    });
    assert.equal(line(again.result), "Last time 합성어 didn't come through. Want to try again?");
    const marked = again.result.components.find((part) => part.type === 'term');
    assert.equal(marked?.type === 'term' && marked.notHeardLastTime, true);
    const vehicle = practise({
      status: 'passed',
      rows: [
        row({
          referenceId: 'Q210988',
          referenceSourceId: 'wikidata:Q210988',
          referenceUrl: 'https://www.wikidata.org/wiki/Q210988',
          term: '합성차',
        }),
        row({
          matched: 'recalled',
          matchedText: null,
          gloss: 'synthetic hill',
          term: '합성언덕',
          referenceId: 'Q25391',
          referenceSourceId: 'wikidata:Q25391',
          referenceUrl: 'https://www.wikidata.org/wiki/Q25391',
          attempts: 1,
          notHeard: 1,
          lastResult: 'not-heard',
          why: 'not-heard-before',
        }),
      ],
    });
    assert.equal(vehicle.referenceId, 'Q210988');
    assert.equal(vehicle.recalledReferenceId, 'Q25391');
    assert.match(line(vehicle.result) ?? '', /합성차/);
    assert.doesNotMatch(line(vehicle.result) ?? '', /합성언덕/);
    const term = vehicle.result.components.find((part) => part.type === 'term');
    assert.equal(term?.type === 'term' && term.text, '합성차');
    const detail = vehicle.result.components.find((part) => part.type === 'detail');
    assert.equal(
      detail?.type === 'detail' && detail.text,
      'Wikidata · Zetaris\nYou tried 합성언덕 (synthetic hill) before.',
    );
  });

  it('says plainly when there is no word, more than one, a script it cannot show, or no answer', () => {
    const cases: [PracticePick, string, string][] = [
      [
        { status: 'passed', rows: [] },
        'no-match',
        "I don't have a Korean word for synthetic animal yet.",
      ],
      [
        { status: 'passed', rows: [row({ term: null })] },
        'no-match',
        "I don't have a Korean word for synthetic animal yet.",
      ],
      [
        {
          status: 'passed',
          rows: [
            row(),
            row({
              referenceId: 'Q71516',
              referenceSourceId: 'wikidata:Q71516',
              referenceUrl: 'https://www.wikidata.org/wiki/Q71516',
            }),
          ],
        },
        'ambiguous',
        'Not sure which word fits this.',
      ],
      [
        { status: 'passed', rows: [row({ term: 'جمل' })] },
        'not-displayable',
        "I can't show that word's letters yet.",
      ],
      [
        { status: 'failed', phase: 'timeout' },
        'unavailable',
        "Couldn't get the Korean word this time.",
      ],
      [
        { status: 'failed', phase: 'connect' },
        'unavailable',
        "Couldn't get the Korean word this time.",
      ],
      [
        { status: 'failed', phase: 'integrity' },
        'integrity',
        "Couldn't get the Korean word this time.",
      ],
    ];
    for (const [pick, reason, words] of cases) {
      const said = practise(pick);
      assert.equal(said.reason, reason);
      assert.equal(said.referenceId, null);
      assert.equal(line(said.result), words);
      assert.deepEqual(
        said.result.components.map((part) => part.type),
        ['subject', 'annotation', 'dialogue'],
      );
      assert.equal(ProviderResult.safeParse(said.result).success, true);
    }
  });

  it('changes nothing when there is no guess to look up', () => {
    const unlabelled = standIn(SESSION, IDS, {
      ...facts,
      referent: { ...referent, label: 'Ω meter' },
    });
    assert.ok(unlabelled);
    const said = practiceResult(unlabelled, {
      language: 'ko',
      languageName: 'Korean',
      confidence: 0.85,
      pick: { status: 'passed', rows: [row()] },
    });
    assert.equal(said.reason, 'no-guess');
    assert.deepEqual(said.result, unlabelled.result);
  });

  it('answers an attempt with what Boopy heard, citing the attempt and never quoting it', () => {
    const practised = practise({ status: 'passed', rows: [row()] });
    const task = {
      revision: 2,
      source: practised.result.source,
      sessionId: SESSION,
      taskId: IDS.taskId,
      components: [...practised.result.components, { type: 'status', code: 'not-sent' }],
    } as unknown as TaskView;
    for (const [heard, words, asks] of [
      ['heard', 'I heard 합성어.', false],
      ['not-heard', "I didn't catch 합성어 there. Try again?", true],
      ['unclear', "I didn't hear any Korean there. Try again?", true],
    ] as const) {
      const correction = correctionResult(task, {
        attemptEventId: 'evt_attempt',
        heard,
        term: '합성어',
        languageName: 'Korean',
      });
      assert.equal(ProviderResult.safeParse(correction).success, true);
      assert.equal(correction.baseRevision, 2);
      assert.equal(line(correction), words);
      const dialogue = correction.components.find((part) => part.type === 'dialogue');
      assert.deepEqual(dialogue?.type === 'dialogue' && dialogue.evidenceIds, ['evt_attempt']);
      assert.equal(
        correction.components.some((part) => part.type === 'voice_reply'),
        asks,
      );
      assert.deepEqual(
        correction.components.filter((part) => ['annotation', 'detail'].includes(part.type)),
        practised.result.components.filter((part) => ['annotation', 'detail'].includes(part.type)),
      );
      const term = correction.components.find((part) => part.type === 'term');
      assert.equal(term?.type === 'term' && term.notHeardLastTime, heard === 'not-heard');
      assert.equal(term?.type === 'term' && term.heardLastTime, heard === 'heard');
      assert.doesNotMatch(JSON.stringify(correction), /있어요/);
    }
  });
});

describe('an unsure guess', () => {
  it('says so in the first line', () => {
    const plan = standIn(SESSION, IDS, { ...facts, referent: { ...referent, label: 'camel' } });
    assert.ok(plan);
    const row: PickedRow = {
      referenceId: 'Q7375',
      matched: 'subject',
      matchedText: 'camel',
      term: '합성어',
      gloss: null,
      description: null,
      referenceSourceId: 'wikidata:Q7375',
      revisionId: '101',
      modifiedAt: '1970-01-01T00:00:00Z',
      retrievedAt: '1970-01-01T00:00:02.000Z',
      referenceUrl: 'https://www.wikidata.org/wiki/Q7375',
      license: 'CC0-1.0',
      status: 'external-unreviewed',
      attempts: 0,
      notHeard: 0,
      onSource: 0,
      lastAt: null,
      lastResult: null,
      why: 'new',
    };
    for (const confidence of [null, 0.3]) {
      const said = practiceResult(plan, {
        language: 'ko',
        languageName: 'Korean',
        pick: { status: 'passed', rows: [row] },
        confidence,
      });
      const line = said.result.components.find((part) => part.type === 'dialogue');
      assert.equal(
        line?.type === 'dialogue' && line.text,
        "Camel? I'm not sure. In Korean, that's 합성어. Can you say it?",
      );
    }
  });
});

describe("the model's own words in the goal language", () => {
  it('are never shown as Boopy’s line'.replace('’', "'"), () => {
    const said = standIn(SESSION, IDS, {
      ...facts,
      referent: { ...referent, label: 'Ω meter' },
      dialogue: facts.dialogue && {
        ...facts.dialogue,
        text: 'It looks like a dune: 사구 in Korean.',
      },
    });
    assert.ok(said);
    const practised = practiceResult(said, {
      language: 'ko',
      personLanguage: 'en',
      languageName: 'Korean',
      pick: { status: 'passed', rows: [] },
      confidence: 0.9,
    });
    const line = practised.result.components.find((part) => part.type === 'dialogue');
    assert.equal(
      line?.type === 'dialogue' && line.text,
      "I don't have a Korean word for this yet.",
    );
    assert.doesNotMatch(JSON.stringify(practised.result.components), /사구/);
    const plain = practiceResult(said, {
      language: 'fr',
      personLanguage: 'en',
      languageName: 'French',
      pick: { status: 'passed', rows: [] },
      confidence: 0.9,
    });
    const kept = plain.result.components.find((part) => part.type === 'dialogue');
    assert.equal(kept?.type === 'dialogue' && kept.text, 'It looks like a dune: 사구 in Korean.');
  });
});
