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

  it('measures the limit in UTF-8 bytes', () => {
    const pad = (bytes: number) => `{"p":"${'a'.repeat(bytes - 8)}"}`;
    assert.equal(Buffer.byteLength(pad(MAX_FILE_BYTES)), MAX_FILE_BYTES);
    assert.ok(readContainer(pad(MAX_FILE_BYTES)));
    assert.equal(readContainer(pad(MAX_FILE_BYTES + 1)), null);
    const hangul = `{"p":"${'가'.repeat(MAX_FILE_BYTES / 3)}"}`;
    assert.ok(hangul.length < MAX_FILE_BYTES);
    assert.equal(readContainer(hangul), null);
  });
});

describe('activity file envelope', () => {
  it('reads a strict envelope and hashes the exact content', () => {
    const content = JSON.stringify(envelope());
    const read = readActivityFile(content);
    assert.equal(read.kind, 'read');
    if (read.kind !== 'read') return;
    assert.equal(read.container, 'json');
    assert.equal(read.artifactSha256, sha256(Buffer.from(content, 'utf8')));
    assert.equal(read.file.author, 'Grok Bot');
    assert.deepEqual(read.file.activity, korean());
    const fenced = `Grok says:\n\`\`\`json\n${content}\n\`\`\``;
    const again = readActivityFile(fenced);
    assert.equal(again.kind === 'read' && again.container, 'fenced-json');
    assert.equal(again.kind === 'read' && again.artifactSha256, sha256(fenced));
  });

  it('refuses unreadable content', () => {
    assert.deepEqual(readActivityFile('not json'), { kind: 'unreadable' });
    assert.deepEqual(readActivityFile(`{"pad":"${'a'.repeat(MAX_FILE_BYTES)}"}`), {
      kind: 'unreadable',
    });
  });

  it('reports up to eight path: message issues', () => {
    const issues = (value: unknown) => {
      const read = readActivityFile(JSON.stringify(value));
      assert.equal(read.kind, 'invalid');
      return read.kind === 'invalid' ? read.issues : [];
    };
    assert.deepEqual(issues({ ...envelope(), extra: true }), [
      'file: Remove the unsupported field "extra".',
    ]);
    assert.deepEqual(issues({ ...envelope(), author: 'جروك' }), [`author: ${SCRIPT_MESSAGE}`]);
    const { activity: _activity, ...missing } = envelope();
    assert.deepEqual(issues(missing), ['activity: Required.']);
    assert.match(issues({ ...envelope(), type: 'boopy.activity-reply' })[0] ?? '', /^type: /);
    assert.match(
      issues({ ...envelope(), binding: { requestId: 'arq_k1', packageId: 'ctx_x' } })[0] ?? '',
      /^binding\.packetSha256: /,
    );
    const capped = issues({
      type: 1,
      version: 2,
      binding: { requestId: 1, packageId: 2, packetSha256: 3 },
      author: 4,
      fallbackText: 5,
      extra: 6,
    });
    assert.equal(capped.length, 8);
    const long = issues({ ...envelope(), [`<${'x'.repeat(500)}`]: 1 });
    assert.deepEqual(long, ['file: Remove the unsupported field (unprintable key).']);
    for (const key of [
      'https://evil.example/x',
      'www.evil',
      'javascript:x',
      'a b',
      'x'.repeat(41),
      'caf\u00e9',
    ])
      assert.deepEqual(issues({ ...envelope(), [key]: 1 }), [
        'file: Remove the unsupported field (unprintable key).',
      ]);
    assert.deepEqual(issues({ ...envelope(), ['x'.repeat(40)]: 1, 'b-2_c': 2, 'https://x': 3 }), [
      `file: Remove the unsupported fields "${'x'.repeat(40)}", "b-2_c", (unprintable key).`,
    ]);
  });

  it('keeps fallback text multiline and requires it', () => {
    const read = readActivityFile(
      JSON.stringify({ ...envelope(), fallbackText: 'Line one.\nLine two.' }),
    );
    assert.equal(read.kind === 'read' && read.file.fallbackText, 'Line one.\nLine two.');
    const missing = readActivityFile(JSON.stringify({ ...envelope(), fallbackText: '' }));
    assert.deepEqual(missing.kind === 'invalid' && missing.issues, [
      'fallbackText: Must not be empty.',
    ]);
  });
});

describe('activity body', () => {
  it('accepts the Korean, Morocco and scale examples', () => {
    const activity = valid(korean());
    assert.equal(arrangeOf(activity).tokens[0]?.label.gloss, 'camel');
    assert.equal(sequenceOf(activity).tiles.length, 5);
    assert.equal(valid(morocco(), NONE).components.length, 1);
    assert.equal(valid(scale(), NONE).hints.length, 0);
    const { hints: _hints, ...noHints } = scale();
    assert.deepEqual(valid(noHints, NONE).hints, []);
  });

  it('marks unknown component and axis kinds unsupported', () => {
    const body = korean();
    (body.components as unknown[]).splice(1, 1, { type: 'map', pins: [] });
    assert.deepEqual(issuesOf(body), [
      'activity.components.1.type: Boopy does not support this component yet. Use arrange or sequence.',
    ]);
    const axis = morocco();
    (axis.components as { axis: unknown }[])[0] = {
      ...(axis.components as object[])[0],
      axis: { kind: 'clock' },
    } as { axis: unknown };
    assert.deepEqual(issuesOf(axis, NONE), [
      'activity.components.0.axis.kind: Boopy does not support this axis yet. Use viewer-left-right, scale or number.',
    ]);
  });

  it('enforces component counts, kinds and keys', () => {
    const none = { ...korean(), components: [] };
    assert.match(issuesOf(none)[0] ?? '', /^activity\.components: /);
    const both = korean();
    const components = both.components as Record<string, unknown>[];
    assert.match(
      issuesOf({ ...both, components: [components[0], components[0]] })[0] ?? '',
      /one of each/,
    );
    assert.match(
      issuesOf({ ...both, components: [components[0], components[1], components[1]] })[0] ?? '',
      /^activity\.components: /,
    );
    const swapped = korean();
    const tokens = (swapped.components as { tokens: { key: string }[] }[])[0]?.tokens ?? [];
    for (const token of tokens) token.key = token.key === 'a' ? 'b' : 'a';
    assert.match(issuesOf(swapped).join('\n'), /Use token keys a to d in order/);
    const extra = { ...korean(), layout: { x: 1 } };
    assert.deepEqual(issuesOf(extra), ['activity: Remove the unsupported field "layout".']);
  });

  it('enforces axis rules', () => {
    const leftRight = (count: number, target?: unknown) => {
      const body = korean();
      const arrange = (body.components as Record<string, unknown>[])[0] as Record<string, unknown>;
      arrange.tokens = Array.from({ length: count }, (_, i) => ({
        key: 'abcd'[i],
        label: { text: `w${i}`, language: 'en' },
        sourceId: null,
      }));
      if (target === undefined) delete arrange.target;
      else arrange.target = target;
      return body;
    };
    assert.ok(valid(leftRight(2)));
    assert.ok(valid(leftRight(2, null)));
    assert.match(issuesOf(leftRight(3)).join('\n'), /exactly two tokens/);
    assert.match(
      issuesOf(leftRight(2, { subject: 'a', relation: 'left-of', object: 'a' })).join('\n'),
      /different tokens/,
    );
    assert.match(
      issuesOf(leftRight(2, { subject: 'a', relation: 'above', object: 'b' })).join('\n'),
      /target\.relation/,
    );
    const scaled = scale();
    const arrange = (scaled.components as Record<string, unknown>[])[0] as Record<string, unknown>;
    arrange.target = { subject: 'a', relation: 'left-of', object: 'b' };
    assert.match(issuesOf(scaled, NONE).join('\n'), /no target/);
    arrange.target = null;
    arrange.tokens = (arrange.tokens as unknown[]).slice(0, 1);
    assert.match(issuesOf(scaled, NONE).join('\n'), /two to four tokens/);
    const number = (axis: Record<string, unknown>) => {
      const body = morocco();
      const entry = (body.components as Record<string, unknown>[])[0] as Record<string, unknown>;
      entry.axis = { kind: 'number', ...axis };
      return body;
    };
    assert.ok(valid(number({ min: 0, max: 1, step: 0.1 }), NONE));
    assert.ok(valid(number({ min: 0, max: 0.3, step: 0.1 }), NONE));
    assert.ok(valid(number({ min: -10, max: 10, step: 0.02 }), NONE));
    assert.ok(valid(number({ min: 0, max: 1000, step: 1 }), NONE));
    assert.ok(valid(number({ min: -1e9, max: 1e9, step: 2e6 }), NONE));
    assert.ok(valid(number({ min: 0, max: 0.001, step: 0.000001 }), NONE));
    for (const [axis, pattern] of [
      [{ min: 5, max: 5, step: 1 }, /min below max/],
      [{ min: 0, max: 10, step: 0 }, /step/],
      [{ min: 0, max: 10, step: 3 }, /whole number/],
      [{ min: 0, max: 1001, step: 1 }, /at most 1000/],
      [{ min: 0, max: 10, step: 1, unit: 'dirhams per km!' }, /unit/],
      [{ min: 0, max: 10 }, /step/],
      [{ min: 0, max: 2e9, step: 2e6 }, /1000000000/],
      [{ min: -1e308, max: 1e308, step: 1e306 }, /1000000000/],
      [{ min: 0, max: 0.0005, step: 0.0000005 }, /0\.000001|6 decimal/],
      [{ min: 0.1234567, max: 1.1234567, step: 0.5 }, /6 decimal/],
      [{ min: 0, max: 1, step: 0.0000001 }, /0\.000001|6 decimal/],
    ] as const)
      assert.match(issuesOf(number(axis), NONE).join('\n'), pattern, JSON.stringify(axis));
    const infinite = JSON.parse(
      JSON.stringify(number({ min: 0, max: 10, step: 1 })).replace('"max":10', '"max":1e400'),
    );
    assert.match(issuesOf(infinite, NONE).join('\n'), /max/);
  });

  it('accepts decimal prices exactly in integer micro-units', () => {
    const price = { kind: 'number' as const, min: 999999.99, max: 1000000.06, step: 0.01 };
    const body = morocco();
    (body.components as Record<string, unknown>[])[0] = {
      type: 'arrange',
      axis: { ...price, unit: 'MAD' },
      tokens: [{ key: 'a', label: { text: 'Price', language: 'en' }, sourceId: null }],
    };
    const activity = valid(body, NONE);
    assert.equal(snapValue(price, 1), 1000000.06);
    assert.equal(snapValue(price, 0), 999999.99);
    assert.equal(snapValue(price, 0.5), 1000000.03);
    assert.equal(
      digestOf(activity, { positions: { a: 0.5 }, chosen: [], hintsRevealed: 0 }),
      'arrange: Price = 1000000.03 MAD | hints: 0 of 1',
    );
    const odd = morocco();
    (odd.components as Record<string, unknown>[])[0] = {
      type: 'arrange',
      axis: { kind: 'number', min: 0, max: 1, step: 0.3 },
      tokens: [{ key: 'a', label: { text: 'Price', language: 'en' }, sourceId: null }],
    };
    assert.match(issuesOf(odd, NONE).join('\n'), /whole number/);
  });

  it('enforces sequence rules', () => {
    const sequence = (tiles: unknown, joiner = 'space') => {
      const body = korean();
      (body.components as Record<string, unknown>[])[1] = {
        type: 'sequence',
        joiner,
        language: 'ko',
        tiles,
      };
      return body;
    };
    const words = (texts: string[], keys = texts.map((_, i) => `t${i + 1}`)) =>
      texts.map((text, i) => ({ key: keys[i], text }));
    assert.ok(valid(sequence(words(['a', 'b', 'c']))));
    assert.match(
      issuesOf(sequence(words(['a', 'b', 'c'], ['t2', 't1', 't3']))).join('\n'),
      /Use tile keys t1 to t8 in order/,
    );
    assert.match(issuesOf(sequence(words(['a', 'b']))).join('\n'), /tiles/);
    assert.match(issuesOf(sequence(words('abcdefghi'.split('')))).join('\n'), /tiles/);
    assert.match(issuesOf(sequence(words(['a', 'b', 'c'], ['t1', 't1', 't2']))).join('\n'), /keys/);
    assert.match(
      issuesOf(sequence(words(['\ub099\ud0c0', '\u1102\u1161\u11a8\u1110\u1161', 'c']))).join('\n'),
      /unique/,
    );
    assert.match(issuesOf(sequence(words(['a', 'b', 'c'], ['t1', 't2', 't9']))).join('\n'), /key/);
    assert.match(issuesOf(sequence(words(['a', 'a', 'c']))).join('\n'), /unique/);
    assert.match(issuesOf(sequence(words(['two words', 'b', 'c']))).join('\n'), /one word/);
    assert.match(issuesOf(sequence(words(['가'.repeat(25), 'b', 'c']))).join('\n'), /24/);
    const step = 'Ask the driver to use the meter before you leave';
    assert.equal(step.length, 48);
    assert.ok(valid(sequence(words([step, 'Agree on a fare', 'Pay in cash']), 'list')));
    assert.match(
      issuesOf(sequence(words([`${step}!`, 'b', 'c']), 'list')).join('\n'),
      /at most 48/,
    );
  });

  it('allows only listed sources, and none for a legacy request', () => {
    assert.ok(valid(korean(), SOURCES));
    assert.match(
      issuesOf(korean(), new Set(['ctx_synthetic1:itm_9'])).join('\n'),
      /^activity\.components\.0\.tokens\.0\.sourceId: Use a source ID from the request, or null\.$/m,
    );
    assert.match(issuesOf(korean(), NONE).join('\n'), /sourceId/);
  });

  it('applies display rules inside the body', () => {
    const body = korean();
    (body as { title: string }).title = 'Camel <b>and</b> tent';
    const labels = korean();
    const token = (labels.components as { tokens: { label: { text: string } }[] }[])[0]?.tokens[1];
    if (token) token.label.text = 'خيمة';
    const hints = korean();
    (hints.hints as { text: string; language: string }[]).push(
      { text: 'Open https://example.test', language: 'en' },
      { text: 'Fourth hint', language: 'en' },
    );
    assert.deepEqual(issuesOf(body), ['activity.title: Use plain text without markup.']);
    assert.deepEqual(issuesOf(labels), [
      `activity.components.0.tokens.1.label.text: ${SCRIPT_MESSAGE}`,
    ]);
    assert.match(issuesOf(hints).join('\n'), /^activity\.hints: Use at most 3 items\.$/m);
  });
});

describe('derived values', () => {
  it('relates two tokens only when both are placed and apart', () => {
    assert.equal(relationOf({ a: null, b: 0.5 }, 'a', 'b'), null);
    assert.equal(relationOf({ a: 0.22, b: 0.71 }, 'a', 'b'), 'left-of');
    assert.equal(relationOf({ a: 0.22, b: 0.71 }, 'b', 'a'), 'right-of');
    assert.equal(relationOf({ a: 0.5, b: 0.59 }, 'a', 'b'), 'unclear');
    assert.equal(relationOf({ a: 0.2, b: 0.3 }, 'a', 'b'), 'left-of');
    assert.equal(relationOf({ a: 0.7, b: 0.6 }, 'a', 'b'), 'right-of');
    assert.equal(relationOf({ a: 0.8, b: 0.7 }, 'a', 'b'), 'right-of');
    assert.equal(relationOf({ a: 0.7, b: 0.8 }, 'a', 'b'), 'left-of');
    assert.equal(relationOf({ a: 0.5, b: 0.5999999994 }, 'a', 'b'), 'unclear');
  });

  it('orders placed tokens and reports ties', () => {
    assert.deepEqual(orderOf({ a: 0.9, b: null, c: 0.1 }, ['a', 'b', 'c']), {
      order: ['c', 'a'],
      ties: false,
    });
    assert.deepEqual(orderOf({ a: 0.5, b: 0.5, c: 0.95 }, ['a', 'b', 'c']), {
      order: ['a', 'b', 'c'],
      ties: true,
    });
    assert.deepEqual(orderOf({ a: 0.3, b: 0.2 }, ['a', 'b']), { order: ['b', 'a'], ties: false });
    assert.deepEqual(orderOf({ a: 0.8, b: 0.7 }, ['a', 'b']), { order: ['b', 'a'], ties: false });
    assert.deepEqual(orderOf({ a: null }, ['a']), { order: [], ties: false });
  });

  it('snaps numbers to the step without floating noise', () => {
    const fare = { kind: 'number' as const, min: 0, max: 200, step: 5, unit: 'MAD' };
    assert.equal(snapValue(fare, 0.25), 50);
    assert.equal(snapValue(fare, 0.26), 50);
    assert.equal(snapValue(fare, 0.2625), 55);
    assert.equal(snapValue(fare, 0), 0);
    assert.equal(snapValue(fare, 1), 200);
    assert.equal(snapValue(fare, null), null);
    const tenths = { kind: 'number' as const, min: 0, max: 1, step: 0.1 };
    assert.equal(snapValue(tenths, 0.3), 0.3);
    assert.equal(snapValue(tenths, 0.7), 0.7);
    const short = { kind: 'number' as const, min: 0, max: 0.3, step: 0.1 };
    assert.equal(snapValue(short, 1), 0.3);
    assert.equal(snapValue(short, 2 / 3), 0.2);
    const signed = { kind: 'number' as const, min: -10, max: 10, step: 0.5 };
    assert.equal(snapValue(signed, 0.5), 0);
    assert.equal(snapValue(signed, 0.01), -10);
    assert.equal(snapValue(signed, 0.03), -9.5);
  });

  it('derives relation, target match, order, ties and values per axis', () => {
    const k = arrangeOf(valid(korean()));
    assert.deepEqual(deriveArrangement(k, { a: 0.22, b: 0.71 }), {
      relation: 'left-of',
      matchesTarget: true,
      order: ['a', 'b'],
      ties: false,
      values: null,
    });
    assert.equal(deriveArrangement(k, { a: 0.9, b: 0.1 }).matchesTarget, false);
    assert.equal(deriveArrangement(k, { a: 0.5, b: 0.52 }).matchesTarget, false);
    assert.equal(deriveArrangement(k, { a: null, b: 0.52 }).matchesTarget, false);
    const untargeted = { ...k, target: null };
    assert.equal(deriveArrangement(untargeted, { a: 0.9, b: 0.1 }).relation, 'right-of');
    assert.equal(deriveArrangement(untargeted, { a: 0.9, b: 0.1 }).matchesTarget, null);
    const m = arrangeOf(valid(morocco(), NONE));
    assert.deepEqual(deriveArrangement(m, { a: 0.25 }), {
      relation: null,
      matchesTarget: null,
      order: ['a'],
      ties: false,
      values: { a: 50 },
    });
    assert.deepEqual(deriveArrangement(m, { a: null }).values, { a: null });
    const s = arrangeOf(valid(scale(), NONE));
    assert.deepEqual(deriveArrangement(s, { a: 0.4, b: 0.45, c: null }), {
      relation: null,
      matchesTarget: null,
      order: ['a', 'b'],
      ties: true,
      values: null,
    });
  });

  it('joins sequence text per joiner', () => {
    const tiles = sequenceOf(valid(korean()));
    assert.equal(sequenceText(tiles, ['t2', 't4', 't3', 't1']), '낙타가 텐트 왼쪽에 있어요');
    assert.equal(sequenceText(tiles, []), '');
    assert.equal(sequenceText({ ...tiles, joiner: 'list' }, ['t2', 't1']), '낙타가; 있어요');
  });
});

describe('tile display order', () => {
  it('orders tiles by the SHA-256 of activityId:tileKey, never by the file order', () => {
    const tiles = ['t1', 't2', 't3', 't4', 't5'].map((key) => ({ key, text: key }));
    const ordered = tileDisplayOrder('act_k1', tiles);
    assert.deepEqual(
      ordered.map((tile) => tile.key),
      [...tiles]
        .map((tile) => tile.key)
        .sort((a, b) => sha256(`act_k1:${a}`).localeCompare(sha256(`act_k1:${b}`))),
    );
    assert.deepEqual(tileDisplayOrder('act_k1', [...tiles].reverse()), ordered);
    assert.notDeepEqual(
      tileDisplayOrder('act_k2', tiles).map((tile) => tile.key),
      ordered.map((tile) => tile.key),
    );
    assert.deepEqual(
      tiles.map((tile) => tile.key),
      ['t1', 't2', 't3', 't4', 't5'],
    );
  });
});

describe('digest', () => {
  const k = valid(korean());
  const digest = (positions: Record<string, number | null>, chosen: string[], hints = 0) =>
    digestOf(k, { positions, chosen, hintsRevealed: hints });

  it('matches the contract example and the other left-right forms', () => {
    assert.equal(
      digest({ a: 0.22, b: 0.71 }, ['t2', 't4', 't3', 't1'], 1),
      'arrange: 낙타 left of 텐트 (your view); requested 낙타 left of 텐트; arrangement matches | sequence: "낙타가 텐트 왼쪽에 있어요" | hints: 1 of 2',
    );
    assert.equal(
      digest({ a: 0.9, b: 0.2 }, []),
      'arrange: 낙타 right of 텐트 (your view); requested 낙타 left of 텐트; arrangement does not match | sequence: (empty) | hints: 0 of 2',
    );
    assert.equal(
      digest({ a: 0.5, b: 0.55 }, ['t1'], 2),
      'arrange: 낙타 and 텐트 too close to tell; requested 낙타 left of 텐트; arrangement does not match | sequence: "있어요" | hints: 2 of 2',
    );
    assert.equal(
      digest({ a: null, b: 0.55 }, ['t1']),
      'arrange: not placed; requested 낙타 left of 텐트; arrangement does not match | sequence: "있어요" | hints: 0 of 2',
    );
    const untargeted = structuredClone(k);
    const arrange = arrangeOf(untargeted);
    arrange.target = null;
    assert.equal(
      digestOf(untargeted, { positions: { a: 0.1, b: 0.9 }, chosen: [], hintsRevealed: 0 }),
      'arrange: 낙타 left of 텐트 (your view) | sequence: (empty) | hints: 0 of 2',
    );
  });

  it('reports scale order, closeness and unplaced tokens', () => {
    const s = valid(scale(), NONE);
    const of = (positions: Record<string, number | null>) =>
      digestOf(s, { positions, chosen: [], hintsRevealed: 0 });
    assert.equal(
      of({ a: 0.1, b: 0.6, c: null }),
      'arrange: order from Cheaper to Pricier: scarf, lamp; not placed: tagine | hints: 0 of 0',
    );
    assert.equal(
      of({ a: 0.5, b: 0.55, c: 0.9 }),
      'arrange: order from Cheaper to Pricier: scarf, lamp, tagine (some too close to tell) | hints: 0 of 0',
    );
    assert.equal(
      of({ a: null, b: null, c: null }),
      'arrange: not placed: scarf, lamp, tagine | hints: 0 of 0',
    );
  });

  it('reports snapped numbers with their unit', () => {
    const m = valid(morocco(), NONE);
    assert.equal(
      digestOf(m, { positions: { a: 0.25 }, chosen: [], hintsRevealed: 1 }),
      'arrange: My estimate = 50 MAD | hints: 1 of 1',
    );
    assert.equal(
      digestOf(m, { positions: { a: null }, chosen: [], hintsRevealed: 0 }),
      'arrange: My estimate not set | hints: 0 of 1',
    );
    const two = structuredClone(m);
    const arrange = arrangeOf(two);
    if (arrange.axis.kind === 'number') delete arrange.axis.unit;
    arrange.tokens.push({ key: 'b', label: { text: 'Tea', language: 'en' }, sourceId: null });
    assert.equal(
      digestOf(two, { positions: { a: 0.25, b: 0.05 }, chosen: [], hintsRevealed: 0 }),
      'arrange: My estimate = 50; Tea = 10 | hints: 0 of 1',
    );
    const halves = structuredClone(m);
    const half = arrangeOf(halves);
    half.axis = { kind: 'number', min: 0, max: 200, step: 0.5, unit: 'MAD' };
    assert.equal(
      digestOf(halves, { positions: { a: 0.5 }, chosen: [], hintsRevealed: 0 }),
      'arrange: My estimate = 100 MAD | hints: 0 of 1',
    );
    assert.equal(
      digestOf(halves, { positions: { a: 0.0025 }, chosen: [], hintsRevealed: 0 }),
      'arrange: My estimate = 0.5 MAD | hints: 0 of 1',
    );
  });

  it('stays one line within the limit by shortening the sequence quote', () => {
    const long = korean();
    const texts = Array.from({ length: 8 }, (_, i) => `${'Step'.padEnd(46, 'x')} ${i + 1}`);
    (long.components as Record<string, unknown>[])[1] = {
      type: 'sequence',
      joiner: 'list',
      language: 'en',
      tiles: texts.map((text, i) => ({ key: `t${i + 1}`, text })),
    };
    const activity = valid(long);
    const keys = texts.map((_, i) => `t${i + 1}`);
    const line = digestOf(activity, {
      positions: { a: 0.22, b: 0.71 },
      chosen: keys,
      hintsRevealed: 0,
    });
    assert.ok([...line].length <= DIGEST_LIMIT, String([...line].length));
    assert.equal(line.includes('\n'), false);
    assert.match(line, /^arrange: .+ \| sequence: "Step.+…" \| hints: 0 of 2$/);
  });

  it('compares echoes after whitespace normalization only', () => {
    const line = digest({ a: 0.22, b: 0.71 }, ['t2', 't4', 't3', 't1'], 1);
    assert.equal(normalizeEcho(` ${line.replaceAll(' | ', '\n|\t ')} `), normalizeEcho(line));
    assert.notEqual(normalizeEcho(line.replace('matches', 'match')), normalizeEcho(line));
    assert.notEqual(normalizeEcho(line.replace('arrange', 'arr\u200bange')), normalizeEcho(line));
  });
});

describe('reply file', () => {
  const reply = (extra: Record<string, unknown> = {}) => ({
    type: 'boopy.activity-reply',
    version: 1,
    binding: { submissionId: 'sub_k1', activityId: 'act_k1' },
    author: 'Grok Bot',
    echo: 'arrange: x | hints: 0 of 0',
    reply: {
      summary: { text: 'Synthetic example reply for rendering tests.', language: 'en' },
      points: [{ about: 'sequence', text: 'Synthetic point about the sentence.', language: 'en' }],
    },
    next: null,
    ...extra,
  });

  it('reads the envelope and leaves the next activity body for later validation', () => {
    const read = readReplyFile(
      JSON.stringify(reply({ next: { fallbackText: 'Try again.', activity: { any: 1 } } })),
    );
    assert.equal(read.kind, 'read');
    assert.deepEqual(read.kind === 'read' && read.file.next, {
      fallbackText: 'Try again.',
      activity: { any: 1 },
    });
    const none = readReplyFile(JSON.stringify(reply({ next: undefined })));
    assert.equal(none.kind === 'read' && none.file.next, null);
    for (const echo of ['arrange: x\n|\thints: 0 of 0', 'arr\u200bange: x | hints: 0 of 0']) {
      const read = readReplyFile(JSON.stringify(reply({ echo })));
      assert.equal(read.kind === 'read' && read.file.echo, echo);
    }
    const long = readReplyFile(JSON.stringify(reply({ echo: 'x'.repeat(2001) })));
    assert.match(long.kind === 'invalid' ? (long.issues[0] ?? '') : '', /^echo: /);
  });

  it('applies the same container and envelope rules', () => {
    assert.deepEqual(readReplyFile('```json\n[]\n```'), { kind: 'unreadable' });
    const invalid = (extra: Record<string, unknown>) => {
      const read = readReplyFile(JSON.stringify(reply(extra)));
      return read.kind === 'invalid' ? read.issues.join('\n') : '';
    };
    assert.match(invalid({ binding: { submissionId: 'sub_k1' } }), /binding\.activityId/);
    assert.match(
      invalid({ reply: { summary: { text: 'ok', language: 'en' }, points: [] } }),
      /reply\.points/,
    );
    assert.match(
      invalid({
        reply: {
          summary: { text: 'ok', language: 'en' },
          points: [{ about: 'grammar', text: 'x', language: 'en' }],
        },
      }),
      /reply\.points\.0\.about/,
    );
    assert.match(
      invalid({ reply: { summary: { text: 'مرحبا', language: 'ar' }, points: [] } }),
      /reply\.summary\.text: Boopy cannot display/,
    );
    assert.match(invalid({ next: { activity: {} } }), /next\.fallbackText/);
  });
});

describe('requests and views', () => {
  it('parses headset requests', () => {
    assert.deepEqual(ArrangementRequest.parse({ revision: 3, positions: { a: 0.22, b: null } }), {
      revision: 3,
      positions: { a: 0.22, b: null },
    });
    assert.equal(
      ArrangementRequest.safeParse({ revision: 3, positions: { a: 1.2 } }).success,
      false,
    );
    assert.equal(ArrangementRequest.safeParse({ revision: -1, positions: {} }).success, false);
    assert.equal(SequenceRequest.safeParse({ revision: 0, chosen: ['t1', 't1'] }).success, false);
    assert.equal(SequenceRequest.safeParse({ revision: 0, chosen: ['x'] }).success, false);
    assert.ok(SequenceRequest.parse({ revision: 0, chosen: [] }));
  });

  it('describes the example views in section 10', () => {
    const contract = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'activity-contract.md'),
      'utf8',
    );
    const section = contract.slice(contract.indexOf('## 10.'), contract.indexOf('## 11.'));
    const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1] ?? ''),
    );
    assert.equal(blocks.length, 2);
    for (const block of blocks) {
      // Section 10a (which supersedes section 10) adds hintsRevealedSincePrevious; the examples
      // predate it, so it is derived here by its rule before the shape is compared exactly.
      let previous: number[] = [];
      for (const submission of block.submissions) {
        submission.hintsRevealedSincePrevious ??= submission.hintsRevealed.filter(
          (index: number) => !previous.includes(index),
        );
        previous = submission.hintsRevealed;
      }
      const view = ActivityView.parse(block);
      assert.deepEqual(view, block);
    }
    const korean = blocks[0];
    const submission = korean.submissions[0];
    const exported = { ...korean, submissions: [{ ...submission, export: null, reply: null }] };
    assert.ok(ActivityView.parse(exported));
    const notExported = { state: 'not-exported', fileSha256: null, exportedAt: null };
    assert.equal(
      ActivityView.safeParse({
        ...korean,
        submissions: [{ ...submission, export: notExported, reply: null }],
      }).success,
      false,
    );
    assert.ok(
      ActivitySummary.parse({
        activityId: 'act_k1',
        title: 'Camel and tent',
        status: 'active',
        importedAt: '1970-01-01T09:00:00.000Z',
        claimedAuthor: 'Grok Bot',
        submissions: 1,
        awaitingReply: false,
        replyAvailable: true,
        parentActivityId: null,
      }),
    );
  });
});

describe('allowed sources', () => {
  it('keeps baseline evidence except rejected and superseded records, and none for version 1', async () => {
    const { boopy } = testBoopy();
    const first = await boopy.start(startRequest('Synthetic camel and tent.'));
    const photo = first.items.find((item) => item.label === 'Desert photo');
    assert.ok(photo);
    await boopy.act(first.id, { itemId: photo.id, action: 'reject' });
    const packageId = boopy.commit(first.id).committed?.packageId;
    const second = await boopy.start(startRequest('Synthetic correction.'));
    const successorId = boopy.commit(second.id).committed?.packageId;
    assert.ok(packageId && successorId);
    const records = evidenceRecords(boopy.package(packageId));
    const tents = records.find((record) => record.label === 'Tents');
    const successor = evidenceRecords(boopy.package(successorId)).find(
      (record) => record.label === 'Tents',
    );
    assert.ok(tents && successor);
    boopy.supersede({ predecessor: tents, successor });
    const sources = allowedSources(boopy.package(packageId), boopy.supersessions);
    const ids = sources.map((source) => source.sourceId);
    assert.deepEqual(
      ids,
      records
        .filter((record) => record.disposition !== 'rejected' && record !== tents)
        .map((record) => record.sourceId),
    );
    assert.equal(ids.includes(tents.sourceId), false);
    const camels = sources.find((source) => source.label === 'Camels');
    assert.deepEqual(camels, {
      sourceId: records.find((record) => record.label === 'Camels')?.sourceId,
      label: 'Camels',
      gloss: '낙타',
      verification: 'accepted',
    });
    assert.equal(sources.find((source) => source.label === 'How you got there')?.gloss, null);
    const legacy = { ...boopy.package(packageId), version: 1 };
    assert.deepEqual(allowedSources(legacy, []), []);
  });
});
