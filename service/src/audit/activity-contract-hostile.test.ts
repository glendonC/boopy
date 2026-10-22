/** Adversarial checks of containers, text rules, binding shapes and derived values (section 10a). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ActivityBody,
  digestOf,
  displayText,
  normalizeEcho,
  readActivityFile,
  readContainer,
  readReplyFile,
  SCRIPT_MESSAGE,
  snapValue,
  validateActivityBody,
} from '../activity-contract.ts';

const NONE = new Set<string>();
const binding = { requestId: 'arq_audit1', packageId: 'ctx_audit1', packetSha256: 'a'.repeat(64) };
const ELLIPSIS = '\u{2026}';

function body(): Record<string, unknown> {
  return {
    title: 'Camel and tent',
    purpose: 'Synthetic practice.',
    instruction: { text: 'Place the camel left of the tent.', language: 'en' },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'viewer-left-right' },
        tokens: [
          { key: 'a', label: { text: 'camel', language: 'en' }, sourceId: null },
          { key: 'b', label: { text: 'tent', language: 'en' }, sourceId: null },
        ],
        target: { subject: 'a', relation: 'left-of', object: 'b' },
      },
    ],
  };
}

function activityFile(activity: unknown = body(), bindingValue: unknown = binding): string {
  return JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding: bindingValue,
    author: 'Grok Bot',
    fallbackText: 'Synthetic fallback.',
    activity,
  });
}

function replyFile(
  options: { echo?: string; next?: unknown; binding?: Record<string, string> } = {},
): string {
  return JSON.stringify({
    type: 'boopy.activity-reply',
    version: 1,
    binding: options.binding ?? { submissionId: 'sub_audit1', activityId: 'act_audit1' },
    echo: options.echo ?? 'arrange: not placed | hints: 0 of 0',
    reply: {
      summary: { text: 'Synthetic summary.', language: 'en' },
      points: [{ about: 'overall', text: 'Synthetic point.', language: 'en' }],
    },
    next: options.next ?? null,
  });
}

/** Replace the only occurrence, so a test never checks content it failed to change. */
function edit(content: string, from: string, to: string): string {
  assert.equal(content.split(from).length, 2, `expected exactly one ${from}`);
  return content.replace(from, () => to);
}

const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;

function valid(input: unknown): ActivityBody {
  const result = validateActivityBody(input, NONE);
  assert.deepEqual(result.issues, []);
  assert.ok(result.activity);
  return result.activity;
}

function numberBody(axis: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body(),
    components: [
      {
        type: 'arrange',
        axis: { kind: 'number', ...axis },
        tokens: [{ key: 'a', label: { text: 'My estimate', language: 'en' }, sourceId: null }],
      },
    ],
  };
}

const steps = Array.from({ length: 8 }, (_, i) => `${'Step'.padEnd(46, 'y')} ${i + 1}`);
const longList = {
  type: 'sequence',
  joiner: 'list',
  language: 'en',
  tiles: steps.map((text, i) => ({ key: `t${i + 1}`, text })),
};
const threeHints = [1, 2, 3].map((n) => ({ text: `Synthetic hint ${n}.`, language: 'en' }));
const allTiles = steps.map((_, i) => `t${i + 1}`);
const fourTokens = ['a', 'b', 'c', 'd'].map((key) => ({
  key,
  label: { text: `item ${key}`.padEnd(24, key), language: 'en' },
  sourceId: null,
}));

test('audit U1: a duplicate key at any level is unreadable', () => {
  const file = activityFile();
  assert.equal(readActivityFile(file).kind, 'read');
  const other = JSON.stringify({
    ...binding,
    requestId: 'arq_audit2',
    packetSha256: 'b'.repeat(64),
  });
  for (const content of [
    // JSON.parse keeps the second binding, so the file would bind to a request it does not show first.
    edit(file, '"author"', `"binding":${other},"author"`),
    edit(file, '"version":1', '"version":1,"version":1'),
    edit(file, '"title":"Camel and tent"', '"title":"Camel and tent","title":"Tent and camel"'),
    edit(file, '"text":"camel"', '"text":"camel","text":"tent"'),
    edit(
      file,
      '{"type":"boopy.activity"',
      '{"t\\u0079pe":"boopy.activity","type":"boopy.activity"',
    ),
  ])
    assert.equal(readActivityFile(content).kind, 'unreadable', content.slice(0, 160));
  const reply = replyFile();
  assert.equal(readReplyFile(reply).kind, 'read');
  assert.equal(
    readReplyFile(
      edit(
        reply,
        '"activityId":"act_audit1"',
        '"activityId":"act_audit1","activityId":"act_audit2"',
      ),
    ).kind,
    'unreadable',
  );
});

test('audit U1: __proto__, constructor and prototype keys anywhere are unreadable', () => {
  const file = activityFile();
  for (const content of [
    edit(file, '"title"', '"__proto__":{"title":"Other"},"title"'),
    edit(file, '"title"', '"\\u005f_proto__":{"title":"Other"},"title"'),
    edit(file, '"text":"camel"', '"constructor":{"prototype":{}},"text":"camel"'),
    edit(file, '"text":"camel"', '"constructor":"x","text":"camel"'),
    edit(file, '"requestId"', '"prototype":1,"requestId"'),
    edit(
      file,
      '{"type":"boopy.activity"',
      '{"__proto__":{"polluted":true},"type":"boopy.activity"',
    ),
  ])
    assert.equal(readActivityFile(content).kind, 'unreadable', content.slice(0, 160));
  const reply = replyFile({ next: { fallbackText: 'Synthetic next.', activity: body() } });
  assert.equal(readReplyFile(reply).kind, 'read');
  assert.equal(
    readReplyFile(edit(reply, '"title"', '"__proto__":{"title":"Other"},"title"')).kind,
    'unreadable',
  );
});

test('audit U1: nesting deeper than 32 is unreadable without throwing; ordinary depth is not', () => {
  const file = activityFile();
  assert.equal(
    readActivityFile(edit(file, '"title"', `"extra":${nested(20)},"title"`)).kind,
    'read',
  );
  for (const depth of [40, 30_000]) {
    const content = edit(file, '"title"', `"extra":${nested(depth)},"title"`);
    assert.equal(readActivityFile(content).kind, 'unreadable', String(depth));
  }
  const reply = replyFile({ next: { fallbackText: 'Synthetic next.', activity: body() } });
  assert.equal(
    readReplyFile(edit(reply, '"title"', `"extra":${nested(40)},"title"`)).kind,
    'unreadable',
  );
});

test('audit U1: code points above U+FFFF are not displayable', () => {
  for (const value of ['a\u{1d7ce}', 'a\u{1df00}', 'a\u{10780}', '\u{1d400}'])
    assert.equal(
      displayText(200).safeParse(value).error?.issues[0]?.message,
      SCRIPT_MESSAGE,
      JSON.stringify(value),
    );
});

test('audit U1: combining marks left after NFC are rejected; composable ones are kept', () => {
  const line = displayText(60);
  for (const value of [
    'x\u{301}',
    '\u{301}',
    'e\u{20dd}',
    '\u{ac00}\u{302e}',
    'camel\u{300}\u{301}',
  ])
    assert.equal(line.safeParse(value).success, false, JSON.stringify(value));
  assert.equal(line.parse('e\u{301}'), '\u{e9}');
  assert.equal(line.parse('\u{b099}\u{d0c0}'.normalize('NFD')), '\u{b099}\u{d0c0}');
});

test('audit U1: a number axis must be within 1e-9 of a whole number of steps', () => {
  // 1999.999999 / 2 is 999.9999995 steps; the value at x = 1 would be 2000, beyond max.
  const loose = validateActivityBody(numberBody({ min: 0, max: 1999.999999, step: 2 }), NONE);
  assert.equal(loose.activity, null);
});

test('audit U1 guard: valid number axes snap to min, max and values between them', () => {
  for (const axis of [
    { min: 0, max: 200, step: 5 },
    { min: 0, max: 1, step: 0.1 },
    { min: -10, max: 10, step: 0.02 },
    { min: 0, max: 1000, step: 1 },
    { min: 0.5, max: 1.7, step: 0.3 },
  ]) {
    valid(numberBody(axis));
    assert.equal(snapValue(axis, 0), axis.min, JSON.stringify(axis));
    assert.equal(snapValue(axis, 1), axis.max, JSON.stringify(axis));
    for (let i = 0; i <= 1000; i += 1) {
      const value = snapValue(axis, i / 1000);
      assert.ok(value !== null && value >= axis.min && value <= axis.max, `${i} ${value}`);
    }
  }
});

test('audit U1 guard: format characters, selectors, keycaps, indicators and tags stay rejected', () => {
  for (const value of [
    'a\u{200b}b',
    'a\u{200c}b',
    'a\u{2060}b',
    'a\u{feff}b',
    'a\u{202a}b',
    'a\u{2066}b',
    'a\u{2069}b',
    'a\u{200e}b',
    'a\u{61c}b',
    'a\u{180e}b',
    'a\u{fff9}b',
    'a\u{e0041}b',
    'a\u{1d173}b',
    'a\u{fe00}',
    'a\u{fe0e}',
    'a\u{fe0f}',
    'a\u{e0100}',
    '1\u{20e3}',
    '\u{1f1f2}\u{1f1e6}',
  ])
    assert.equal(displayText(200).safeParse(value).success, false, JSON.stringify(value));
});

test('audit U1 guard: words that merely contain scheme letters stay allowed', () => {
  for (const value of [
    'Hotel: Riad Dar',
    'Hostel: near the medina',
    'Profile: camel rider',
    'Telephone the riad first',
  ])
    assert.equal(displayText(200).safeParse(value).success, true, value);
});

test('audit U1 guard: the digest of any valid activity is a valid reply echo within 400', () => {
  const scale = valid({
    ...body(),
    components: [
      {
        type: 'arrange',
        axis: {
          kind: 'scale',
          low: 'Less data'.padStart(24, 'x'),
          high: 'More data'.padStart(24, 'x'),
        },
        tokens: fourTokens,
      },
      longList,
    ],
    hints: threeHints,
  });
  const number = valid({
    ...body(),
    components: [
      {
        type: 'arrange',
        axis: {
          kind: 'number',
          min: -1e9,
          max: -999_999_000,
          step: 1,
          unit: 'MAD'.padEnd(12, 'D'),
        },
        tokens: fourTokens,
      },
      longList,
    ],
    hints: threeHints,
  });
  const leftRight = valid({
    ...body(),
    components: [...(body().components as unknown[]), longList],
    hints: threeHints,
  });
  for (const [activity, positions] of [
    [scale, { a: 0.1, b: 0.15, c: 0.5, d: 0.9 }],
    [scale, { a: 0.1, b: 0.5, c: 0.9, d: null }],
    [number, { a: 0, b: 0.5, c: 1, d: null }],
    [leftRight, { a: 0.5, b: 0.55 }],
  ] as const) {
    const digest = digestOf(activity, { positions, chosen: allTiles, hintsRevealed: 3 });
    assert.ok([...digest].length <= 400, String([...digest].length));
    assert.ok(digest.isWellFormed());
    assert.equal(digest.includes('\n'), false);
    assert.match(digest, /^arrange: .+ \| sequence: ".+\u{2026}" \| hints: 3 of 3$/u);
    const read = readReplyFile(replyFile({ echo: digest }));
    assert.equal(read.kind, 'read', digest);
    assert.equal(read.kind === 'read' && normalizeEcho(read.file.echo), normalizeEcho(digest));
  }
});

test('audit U1 guard: binding identifiers and hashes are matched exactly, never trimmed', () => {
  for (const change of [
    { requestId: ' arq_audit1' },
    { requestId: 'arq_audit1 ' },
    { requestId: 'arq_audit1\n' },
    { requestId: 'arq_audit1\u{200b}' },
    { requestId: '\u{430}rq_audit1' },
    { requestId: 'ARQ_audit1' },
    { packageId: 'ctx_audit1\t' },
    { packetSha256: 'A'.repeat(64) },
    { packetSha256: `${'a'.repeat(64)} ` },
  ])
    assert.equal(
      readActivityFile(activityFile(body(), { ...binding, ...change })).kind,
      'invalid',
      JSON.stringify(change),
    );
  for (const replyBinding of [
    { submissionId: 'sub_audit1 ', activityId: 'act_audit1' },
    { submissionId: 'sub_audit1', activityId: 'ACT_audit1' },
  ])
    assert.equal(readReplyFile(replyFile({ binding: replyBinding })).kind, 'invalid');
});

test('audit U1 guard: NFC comes before limits and tile uniqueness', () => {
  const label = body();
  const components = label.components as { tokens: { label: { text: string } }[] }[];
  const first = components[0]?.tokens[0];
  assert.ok(first);
  first.label.text = '\u{e9}'.normalize('NFD').repeat(24);
  const activity = valid(label);
  const arrange = activity.components[0];
  assert.equal(arrange?.type === 'arrange' && arrange.tokens[0]?.label.text, '\u{e9}'.repeat(24));
  const camel = '\u{b099}\u{d0c0}';
  const tiles = validateActivityBody(
    {
      ...body(),
      components: [
        ...(body().components as unknown[]),
        {
          type: 'sequence',
          joiner: 'space',
          language: 'ko',
          tiles: [
            { key: 't1', text: camel },
            { key: 't2', text: camel.normalize('NFD') },
            { key: 't3', text: '\u{d150}\u{d2b8}' },
          ],
        },
      ],
    },
    NONE,
  );
  assert.equal(tiles.activity, null);
  assert.match(tiles.issues.join('\n'), /unique tile texts/);
});

test('audit U1 guard: echo comparison tolerates whitespace only', () => {
  const digest = `arrange: camel left of tent (your view) | sequence: "a b${ELLIPSIS}" | hints: 1 of 2`;
  assert.equal(normalizeEcho(digest.replaceAll(' ', '\u{3000}')), normalizeEcho(digest));
  assert.equal(normalizeEcho(`\n ${digest.replaceAll(' | ', '\n|\t')} `), normalizeEcho(digest));
  for (const changed of [
    digest.replace(ELLIPSIS, '...'),
    digest.replace(`"a b${ELLIPSIS}"`, `\u{201c}a b${ELLIPSIS}\u{201d}`),
    digest.replace('1 of 2', '1 of 3'),
    digest.replace('camel', 'Camel'),
  ])
    assert.notEqual(normalizeEcho(changed), normalizeEcho(digest), changed);
});

test('audit U1 guard: only one leading byte order mark is removed', () => {
  assert.equal(readContainer(`\u{feff}${activityFile()}`)?.container, 'json');
  assert.equal(readContainer(`\u{feff}\u{feff}${activityFile()}`), null);
});
