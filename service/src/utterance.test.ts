import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { needsTarget, readUtterance } from './utterance.ts';

describe('readUtterance', () => {
  const cases: [string, boolean, ReturnType<typeof readUtterance>][] = [
    ['I want to practice talking about this trip in Korean.', false, { kind: 'ask' }],
    ['What is this?', false, { kind: 'ask' }],
    ['Save it', false, { kind: 'commit' }],
    ['Okay, send it to Muse', false, { kind: 'commit' }],
    ['done', false, { kind: 'commit' }],
    ['Use the whole scene', false, { kind: 'rescope', scope: 'scene' }],
    ['No, I mean this one', false, { kind: 'refocus' }],
    ['not that, this one', false, { kind: 'refocus' }],
    ['I already know this', true, { kind: 'item', action: 'known' }],
    ['ignore that', true, { kind: 'item', action: 'ignore' }],
    ['This matters', true, { kind: 'item', action: 'matters' }],
    [
      "Not that, we didn't camp",
      true,
      { kind: 'item', action: 'reject', reason: "we didn't camp" },
    ],
    ['No', true, { kind: 'item', action: 'reject' }],
    ['Yes', true, { kind: 'item', action: 'confirm' }],
    ["That's right", true, { kind: 'item', action: 'confirm' }],
    ["No, it's a yurt", true, { kind: 'relabel', label: 'yurt' }],
    ['These are sand dunes', true, { kind: 'relabel', label: 'sand dunes' }],
    ['I also want to talk about the sunset', false, { kind: 'add', text: 'talk about the sunset' }],
    ['We rode them at sunrise', true, { kind: 'note', text: 'We rode them at sunrise' }],
    ['We rode them at sunrise', false, { kind: 'ask' }],
  ];
  for (const [said, targeted, expected] of cases) {
    it(`reads "${said}"${targeted ? ' at a card' : ''}`, () => {
      assert.deepEqual(readUtterance(said, targeted), expected);
    });
  }

  it('reads a relabel without a card as a rejection with its reason', () => {
    assert.deepEqual(readUtterance("No, it's a yurt", false), {
      kind: 'item',
      action: 'reject',
      reason: "it's a yurt",
    });
  });
  const questions = [
    "Don't I already know this",
    "Aren't these right",
    "Shouldn't this matter",
    "Can't you translate this",
    "Won't you explain this",
    "Isn't it a yurt",
    "Don't ignore this",
    "Don't confirm this",
    "Don't save this",
    "Don't rename this to a yurt",
    'Do not reject this',
    'Never mark this as confirmed',
    "Please, don't include this",
    'What is this called in Korean?',
    'Can you translate this?',
    'Is this right?',
    'Why does this matter?',
    'How do I say this?',
    'Can you ignore this?',
    'What if I say save this?',
    'Could you confirm this?',
    'Should I reject this?',
    'Would you rename this to a yurt?',
    'Please, can you save this?',
    'What is this called in Korean',
    'How do I say this',
    'Translate this into Korean.',
    'Please explain why this does not matter.',
    'Describe the whole scene.',
    'Yes?',
    'That is correct?',
    'Ignore this?',
    'Save this?',
    'Rename this to a yurt?',
    'Confirm this？',
    '이거 뭐예요?',
    '이게 맞나요',
    '이것은 무엇인가요',
    '한국어로 어떻게 말하나요',
  ];
  for (const words of questions) {
    it(`keeps question/request "${words}" separate from human verification and mutations`, () => {
      for (const targeted of [true, false]) {
        const reading = readUtterance(words, targeted);
        assert.deepEqual(reading, { kind: 'ask' });
        assert.equal(needsTarget(reading), false);
      }
    });
  }

  it('keeps targeted personal statements exact and does not treat Korean politeness as a question', () => {
    for (const words of [
      'I use this every morning.',
      'I felt Much Colder during that trip.',
      '저는 이걸 매일 아침 써요.',
      '맞아요',
    ])
      assert.deepEqual(readUtterance(words, true), { kind: 'note', text: words });
  });

  it('retains bounded uncertainty statements exactly without changing trust or status', () => {
    for (const words of [
      'Maybe this is important.',
      'Perhaps ignore this.',
      'Possibly this matters.',
      'Probably this is a yurt.',
      'I think this is important.',
      'I guess I already know this.',
      'I suppose this does not matter.',
      'I wonder if I already know this.',
      'I suspect this matters.',
      'I doubt this is important.',
      "I'm not sure this doesn't matter.",
      'I am uncertain whether to save this.',
      "I'm unsure whether to confirm this.",
      "I don't already know this.",
      'I do not know this.',
      'Not sure this is important.',
      'Unsure whether to rename this.',
      'Uncertain whether to ignore this.',
    ]) {
      const reading = readUtterance(words, true);
      assert.deepEqual(reading, { kind: 'note', text: words });
      assert.equal(needsTarget(reading), true);
      assert.deepEqual(readUtterance(words, false), { kind: 'ask' });
    }
    // An explicit question remains a question even when it starts with a hedge.
    assert.deepEqual(readUtterance('Maybe this is important?', true), { kind: 'ask' });
  });

  it('retains explicit commands without question cues', () => {
    for (const [words, reading] of [
      ['Confirm this.', { kind: 'item', action: 'confirm' }],
      ['Please save this.', { kind: 'commit' }],
      [
        'Wrong because that is unsupported.',
        { kind: 'item', action: 'reject', reason: 'that is unsupported' },
      ],
      ['Rename this to a yurt.', { kind: 'relabel', label: 'yurt' }],
      ['Add the sunset.', { kind: 'add', text: 'the sunset.' }],
      ['Ignore this.', { kind: 'item', action: 'ignore' }],
      ["Doesn't matter.", { kind: 'item', action: 'ignore' }],
      ['I already know this.', { kind: 'item', action: 'known' }],
      ['Use the whole scene.', { kind: 'rescope', scope: 'scene' }],
      ['This one.', { kind: 'refocus' }],
    ] as const)
      assert.deepEqual(readUtterance(words, true), reading);
  });

  it('recognizes add commands without rewriting the authored payload', () => {
    for (const prefix of ['ADD', 'And  also', 'I’d\talso like to', 'INCLUDE']) {
      assert.deepEqual(readUtterance(`  ${prefix},  iPhone  사진 — Saya’s Trip!  `, false), {
        kind: 'add',
        text: 'iPhone  사진 — Saya’s Trip!',
      });
    }
    for (const words of ['Add?', 'Do not add iPhone.', 'Can you add iPhone?', 'Add ...'])
      assert.deepEqual(readUtterance(words, false), { kind: 'ask' });
  });
});
