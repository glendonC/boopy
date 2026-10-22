import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ActivityBody,
  ActivityId,
  ActivitySummary,
  ActivityView,
  type ArrangeComponent,
  ArrangementRequest,
  allowedSources,
  DIGEST_LIMIT,
  deriveArrangement,
  digestOf,
  displayText,
  LanguageTag,
  MAX_FILE_BYTES,
  normalizeEcho,
  orderOf,
  ReplyId,
  RequestId,
  readActivityFile,
  readContainer,
  readReplyFile,
  relationOf,
  SCRIPT_MESSAGE,
  type SequenceComponent,
  SequenceRequest,
  SubmissionId,
  sequenceText,
  sha256,
  snapValue,
  tileDisplayOrder,
  validateActivityBody,
} from './activity-contract.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { startRequest, testBoopy } from './testing.ts';

const SOURCE = 'ctx_synthetic1:itm_2';
const SOURCES = new Set([SOURCE]);
const NONE = new Set<string>();

/** The contract's Korean example, synthetic. */
function korean(): Record<string, unknown> {
  return {
    title: 'Camel and tent',
    purpose: 'Practice saying where things are in Korean, using your desert camp.',
    instruction: {
      text: '낙타를 텐트 왼쪽에 놓고 한국어로 말해 보세요.',
      language: 'ko',
      gloss: 'Put the camel to the left of the tent, then say it in Korean.',
    },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'viewer-left-right' },
        tokens: [
          { key: 'a', label: { text: '낙타', language: 'ko', gloss: 'camel' }, sourceId: SOURCE },
          { key: 'b', label: { text: '텐트', language: 'ko', gloss: 'tent' }, sourceId: null },
        ],
        target: { subject: 'a', relation: 'left-of', object: 'b' },
      },
      {
        type: 'sequence',
        joiner: 'space',
        language: 'ko',
        tiles: [
          { key: 't1', text: '있어요' },
          { key: 't2', text: '낙타가' },
          { key: 't3', text: '왼쪽에' },
          { key: 't4', text: '텐트' },
          { key: 't5', text: '오른쪽에' },
        ],
      },
    ],
    hints: [
      { text: 'Start with the camel, then say where it is.', language: 'en' },
      { text: 'The place word comes before 있어요.', language: 'en' },
    ],
  };
}

/** The contract's Morocco example, synthetic. */
function morocco(): Record<string, unknown> {
  return {
    title: 'Petit taxi fare',
    purpose: 'Check your sense of a fair petit taxi fare before you ride.',
    instruction: {
      text: 'What would you expect to pay for a daytime petit taxi from the medina to Gueliz?',
      language: 'en',
    },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'number', min: 0, max: 200, step: 5, unit: 'MAD' },
        tokens: [{ key: 'a', label: { text: 'My estimate', language: 'en' }, sourceId: null }],
      },
    ],
    hints: [{ text: 'Think about the distance and the time of day.', language: 'en' }],
  };
}

function scale(): Record<string, unknown> {
  return {
    title: 'Souk prices',
    purpose: 'Order a few things by what you would expect to pay.',
    instruction: { text: 'Place each item from cheaper to pricier.', language: 'en' },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'scale', low: 'Cheaper', high: 'Pricier' },
        tokens: [
          { key: 'a', label: { text: 'scarf', language: 'en' }, sourceId: null },
          { key: 'b', label: { text: 'lamp', language: 'en' }, sourceId: null },
          { key: 'c', label: { text: 'tagine', language: 'en' }, sourceId: null },
        ],
      },
    ],
    hints: [],
  };
}

function valid(input: unknown, sources: ReadonlySet<string> = SOURCES): ActivityBody {
  const result = validateActivityBody(input, sources);
  assert.deepEqual(result.issues, []);
  assert.ok(result.activity);
  return result.activity;
}

function issuesOf(input: unknown, sources: ReadonlySet<string> = SOURCES): string[] {
  const result = validateActivityBody(input, sources);
  assert.equal(result.activity, null);
  assert.ok(result.issues.length > 0 && result.issues.length <= 8);
  return result.issues;
}

function arrangeOf(activity: ActivityBody): ArrangeComponent {
  const component = activity.components.find((entry) => entry.type === 'arrange');
  assert.ok(component?.type === 'arrange');
  return component;
}

function sequenceOf(activity: ActivityBody): SequenceComponent {
  const component = activity.components.find((entry) => entry.type === 'sequence');
  assert.ok(component?.type === 'sequence');
  return component;
}

function envelope(activity: unknown = korean()): Record<string, unknown> {
  return {
    type: 'boopy.activity',
    version: 1,
    binding: { requestId: 'arq_k1', packageId: 'ctx_synthetic1', packetSha256: '1'.repeat(64) },
    author: 'Grok Bot',
    fallbackText: 'Picture the camel to the left of the tent and say it in Korean.',
    activity,
  };
}

describe('identifiers', () => {
  it('accepts Boopy prefixes and rejects others', () => {
    assert.ok(RequestId.safeParse('arq_k1').success);
    assert.ok(ActivityId.safeParse('act_A-z_09').success);
    assert.ok(SubmissionId.safeParse(`sub_${'x'.repeat(64)}`).success);
    assert.ok(ReplyId.safeParse('rep_1').success);
    for (const bad of ['arq_', `arq_${'x'.repeat(65)}`, 'act_k1', 'arq_a.b', 'ARQ_k1', 'arq_é'])
      assert.equal(RequestId.safeParse(bad).success, false, bad);
    for (const tag of ['en', 'ko', 'kor', 'en-US', 'zh-Hant-TW']) assert.ok(LanguageTag.parse(tag));
    for (const tag of ['EN', 'e', 'english', 'en-', 'en-a', 'en-US-x-y-z'])
      assert.equal(LanguageTag.safeParse(tag).success, false, tag);
  });
});

describe('display text', () => {
  const line = displayText(24);
  const lines = displayText(800, { multiline: true });
  const problem = (schema: typeof line, value: string) =>
    schema.safeParse(value).error?.issues[0]?.message;

  it('normalizes to NFC, trims and counts characters', () => {
    assert.equal(line.parse('  e\u0301  '), 'é');
    assert.equal(problem(line, 'x\u0301'), SCRIPT_MESSAGE);
    assert.equal(line.parse('가'.repeat(24)), '가'.repeat(24));
    assert.equal(line.parse('가'.repeat(24).normalize('NFD')), '가'.repeat(24));
    assert.equal(problem(line, '가'.repeat(25)), 'Use at most 24 characters.');
    assert.equal(problem(line, '   '), 'Must not be empty.');
  });

  it('keeps single lines single and normalizes line breaks where lines are allowed', () => {
    assert.equal(problem(line, 'one\ntwo'), 'Use a single line.');
    assert.equal(problem(line, 'one\u2028two'), 'Use a single line.');
    assert.equal(
      lines.parse('one\r\ntwo\rthree\u2028four\u2029five\n'),
      'one\ntwo\nthree\nfour\nfive',
    );
  });

  it('rejects control characters, markup and links', () => {
    for (const value of [
      'bell\u0007',
      'tab\there',
      'over\u202eride',
      'zero\u200dwidth',
      'soft\u00adhyphen',
      'zero\u200bwidth',
      'word\u2060joiner',
      'mark\u061c',
      'inner\ufeffmark',
      'isolate\u2066x',
      'tag\u{e0041}',
    ])
      assert.equal(problem(line, value), 'Remove control characters.', value);
    for (const value of ['<b>bold</b>', 'a > b', 'a <', '<script>', '\uff1cb\uff1e', 'x \uff1e y'])
      assert.equal(problem(line, value), 'Use plain text without markup.', value);
    for (const value of [
      'https://x.example',
      'see www.example',
      'FTP://files',
      'app+x://open',
      'javascript:alert(1)',
      'Data:text/plain,x',
      'MAILTO:someone',
      'file:notes',
      'call tel:5550100',
      'SMS:5550100',
      'VBScript:x',
      '\ub099\ud0c0javascript:x',
    ])
      assert.equal(problem(displayText(200), value), 'Links are not allowed.', value);
    for (const value of [
      'Hotel: Riad Dar',
      'metadata: 3 items',
      'Time: 10:30',
      'Mobile data: 5 GB',
      'Tel: 0524 00 00 00',
      'Ask for data:',
    ])
      assert.equal(displayText(200).parse(value), value);
  });

  it('accepts Latin, Hangul, punctuation, digits and symbols', () => {
    for (const value of [
      '낙타가 텐트 왼쪽에 있어요',
      'Café crème, s’il vous plaît!',
      '50 MAD (about €5)',
      '½ · 3 × 4 = 12 → °C …',
      'ㄱ ㅏ 한글',
      'Ça va? «oui» “non”',
      '0123456789 # *',
    ])
      assert.equal(displayText(200).parse(value), value.normalize('NFC'));
  });

  it('rejects Hangul fillers and fields with no visible character', () => {
    for (const value of ['\u3164', '\uffa0', '\u115f\u1160', '\u3164 \u3164'])
      assert.equal(problem(line, value), 'Use at least one visible character.', value);
    for (const value of ['\ub099\ud0c0\u3164', 'Grok\u3164Bot', 'a\u115fb'])
      assert.equal(problem(line, value), SCRIPT_MESSAGE, value);
  });

  it('rejects other scripts and emoji with the exact message', () => {
    for (const value of [
      'مرحبا',
      'taxi طاكسي',
      '漢字',
      'こんにちは',
      'Привет',
      '🐪',
      '낙타 🐪',
      '🇲🇦',
      '#\ufe0f\u20e3',
      '👍🏽',
      '©',
      '\u064b',
      '\ue000',
      '\uffff',
      'Γεια',
      'Gr\u043ek',
      '\u231a',
      'a\ufe0e',
      '1\ufe0f\u20e3',
      '\u{1d11e}',
      '\u{1f1f2}\u{1f1e6}',
    ])
      assert.equal(problem(displayText(200), value), SCRIPT_MESSAGE, value);
    assert.equal(
      SCRIPT_MESSAGE,
      'Boopy cannot display this script yet. Use Latin letters or Hangul.',
    );
  });
});

describe('containers', () => {
  const object = '{"type":"boopy.activity"}';

  it('reads one whole JSON object, with or without a byte order mark', () => {
    assert.deepEqual(readContainer(`  ${object}\n`), {
      container: 'json',
      value: { type: 'boopy.activity' },
    });
    assert.equal(readContainer(`\ufeff${object}`)?.container, 'json');
    assert.equal(readContainer(`\ufeff\ufeff${object}`), null);
    assert.equal(readContainer(`${object}\u00a0`)?.container, 'json');
  });

  it('reads exactly one fenced block labelled json', () => {
    const prose = `Here is your activity:\n\n\`\`\`json\n${object}\n\`\`\`\n\nEnjoy.`;
    assert.deepEqual(readContainer(prose), {
      container: 'fenced-json',
      value: { type: 'boopy.activity' },
    });
    assert.equal(readContainer(`~~~~json\n${object}\n~~~~`)?.container, 'fenced-json');
    assert.equal(readContainer(`\ufeff\`\`\`json\n${object}\n\`\`\``)?.container, 'fenced-json');
  });

  it('refuses everything else', () => {
    for (const content of [
      '',
      '[1, 2]',
      'null',
      '"text"',
      '{"a":1} {"b":2}',
      `\`\`\`json\n${object}\n\`\`\`\n\`\`\`json\n${object}\n\`\`\``,
      `\`\`\`\n${object}\n\`\`\``,
      `\`\`\`text\n${object}\n\`\`\``,
      `\`\`\`json\n${object}\n`,
      '```json\n[1]\n```',
      '```json\n{oops}\n```',
      `\`\`\`\`text\n\`\`\`json\n${object}\n\`\`\`\n\`\`\`\``,
      `\`\`\`JSON\n${object}\n\`\`\``,
      `\`\`\`jsonc\n${object}\n\`\`\``,
      `\`\`\`json5\n${object}\n\`\`\``,
      `\`\`\`json title\n${object}\n\`\`\``,
      `\`\`\`text\nnot json\n\`\`\`\n\`\`\`json\n${object}\n\`\`\``,
      `\`\`\`json\n${object}\n\`\`\`\n\`\`\`\nnotes\n\`\`\``,
    ])
      assert.equal(readContainer(content), null, JSON.stringify(content));
  });

  it('reads JSON strictly: unique ordinary keys, bounded depth, finite numbers, whole text', () => {
    const plain =
      '{"s":"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00\u2028","n":[-0.5,1e3,0,true,false,null],"o":{}}';
    assert.deepEqual(readContainer(plain)?.value, JSON.parse(plain));
    const nest = (depth: number) => `{"x":${'['.repeat(depth - 1)}${']'.repeat(depth - 1)}}`;
    assert.ok(readContainer(nest(32)));
    for (const content of [
      '{"a":1,"a":2}',
      '{"x":{"a":1,"\\u0061":2}}',
      '{"__proto__":{"x":1}}',
      '{"x":{"constructor":1}}',
      '{"x":[{"prototype":1}]}',
      nest(33),
      `{"x":${'['.repeat(30000)}${']'.repeat(30000)}}`,
      `{"x":${'{"y":'.repeat(30000)}1${'}'.repeat(30000)}}`,
      '{"n":1e999}',
      '{"n":-1e999}',
      '{"n":01}',
      '{"n":1.}',
      '{"s":"\\ud800"}',
      '{"s":"\\udfff\\ud800"}',
      '{"s":"x\ud800"}',
      '{"s":"tab\there"}',
      "{'s':1}",
      '{"s":1,}',
    ])
      assert.equal(readContainer(content), null, content.slice(0, 40));
  });

  it('trims surrounding whitespace in linear time', () => {
    const object = '{"type":"boopy.activity"}';
    assert.equal(readContainer(` \n\t${object}\r\n `)?.container, 'json');
    for (const content of [
      `x${' '.repeat(64_000)}y`,
      `\`\`\`json\n{${' '.repeat(60_000)}x\n\`\`\``,
    ]) {
      const start = performance.now();
      assert.equal(readContainer(content), null);
      assert.ok(performance.now() - start < 250);
    }
  });
});
