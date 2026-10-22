/** Adversarial checks of the strict activity file reader, derived values and number printing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  digestOf,
  orderOf,
  readActivityFile,
  readContainer,
  readReplyFile,
  relationOf,
  snapValue,
  validateActivityBody,
} from '../activity-contract.ts';

/** A JSON \u escape built at run time, so no escape is ever decoded while this file is written. */
const u = (hex: string) => `\\u${hex}`;

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pieces = [
  'a',
  'Z',
  '0',
  ' ',
  '"',
  '\\',
  '/',
  '\n',
  '\t',
  '\u{0}',
  '\u{1f}',
  '\u{7f}',
  '\u{e9}',
  '\u{b099}',
  '\u{2028}',
  '\u{1f42a}',
  '\u{feff}',
  '\u{a0}',
];
const keyPool = ['', 'a', 'type', 'toString', 'hasOwnProperty', 'valueOf', 'toJSON', 'then', '0'];
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function generator(seed: number) {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const text = () => Array.from({ length: Math.floor(next() * 6) }, () => pick(pieces)).join('');
  const number = () => {
    const n = pick([
      () => Math.floor(next() * 1000) - 500,
      () => (next() - 0.5) * 1e6,
      () => next() * 1e-8,
      () => (next() - 0.5) * 1e300,
      () => Number.MAX_SAFE_INTEGER * next(),
    ])();
    return n === 0 ? 0 : n;
  };
  const value = (depth: number): Json => {
    const kind = Math.floor(next() * (depth > 5 ? 3 : 5));
    if (kind === 0) return text();
    if (kind === 1) return number();
    if (kind === 2) return pick([true, false, null]);
    if (kind === 3) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
    return object(depth + 1);
  };
  const object = (depth: number): { [key: string]: Json } => {
    const result: { [key: string]: Json } = {};
    for (let i = Math.floor(next() * 5); i > 0; i -= 1)
      result[next() < 0.5 ? pick(keyPool) : text()] = value(depth);
    return result;
  };
  return { next, pick, object };
}

test('audit U1b guard: the strict reader returns exactly the value any valid object encodes', () => {
  const { next, object } = generator(Date.parse('1970-01-01T00:00:00.000Z'));
  for (let i = 0; i < 3000; i += 1) {
    const value = object(1);
    let text = JSON.stringify(value, null, [undefined, 2, '\t'][i % 3]);
    if (next() < 0.3) text = text.replaceAll('\n', '\r\n');
    // The generated value is the oracle; JSON.parse is not, because V8 13.6 can mis-decode keys.
    assert.deepStrictEqual(readContainer(text)?.value, value, text.slice(0, 200));
  }
});

test('audit U1b guard: mutated text never throws and is never more lenient than JSON', () => {
  const { next, pick, object } = generator(7);
  const tricky = ['"', '\\', ',', ':', '{', '}', '[', ']', ' ', '\n', '0', '-', 'e', '.', 'u', '/'];
  const unusual = ['\u{a0}', '\u{2028}', '\u{feff}', '\u{0}', '+', '1', 'x', "'", 'E', 't', 'n'];
  for (let i = 0; i < 6000; i += 1) {
    let text = JSON.stringify(object(1));
    for (let edit = Math.floor(next() * 3); edit >= 0; edit -= 1) {
      const at = Math.floor(next() * (text.length + 1));
      const char = pick([...tricky, ...unusual]);
      const op = Math.floor(next() * 3);
      text =
        op === 0
          ? text.slice(0, at) + text.slice(at + 1)
          : op === 1
            ? text.slice(0, at) + char + text.slice(at)
            : text.slice(0, at) + char + text.slice(at + 1);
    }
    const read = readContainer(text);
    let syntax = true;
    try {
      const bare = (text.startsWith('\u{feff}') ? text.slice(1) : text).replace(
        /^[^\S\u{feff}]+|[^\S\u{feff}]+$/gu,
        '',
      );
      JSON.parse(bare);
    } catch {
      syntax = false;
    }
    if (!syntax) assert.equal(read, null, JSON.stringify(text));
  }
});

test('audit U1b guard: strict JSON edges match RFC 8259', () => {
  const value = (text: string) => readContainer(text)?.value;
  assert.deepStrictEqual(value('{"a":1E2,"b":1e+2,"c":1e-2,"d":-12.5e-3,"e":0,"f":-0}'), {
    a: 100,
    b: 100,
    c: 0.01,
    d: -0.0125,
    e: 0,
    f: -0,
  });
  assert.deepStrictEqual(value(`{"a":"\\/\\b\\f\\n\\r\\t\\"\\\\${u('00e9')}"}`), {
    a: '/\b\f\n\r\t"\\\u{e9}',
  });
  assert.deepStrictEqual(value(`{"a":"${u('d83d')}${u('DE00')}"}`), { a: '\u{1f600}' });
  assert.deepStrictEqual(value(`\t\r\n {\t"a"\r\n:\n[ ]\t,"b" : { } }\n`), { a: [], b: {} });
  for (const text of [
    '{"a":01}',
    '{"a":1.}',
    '{"a":.5}',
    '{"a":+1}',
    '{"a":0x10}',
    '{"a":NaN}',
    '{"a":Infinity}',
    '{"a":-1e999}',
    "{'a':1}",
    '{a:1}',
    '{"a":1,}',
    '{"a":[1,]}',
    '{"a":[,1]}',
    '{,"a":1}',
    '{"a":1,,"b":2}',
    '{"a"::1}',
    '{"a" 1}',
    '{"a":tru}',
    '{"a":True}',
    '{"a":1}//',
    '{"a":/**/1}',
    '{"a":"\\x41"}',
    '{"a":"\\\'"}',
    `{"a":"${u('12')}"}`,
    `{"a":"${u('12G4')}"}`,
    '{"a":"\t"}',
    '{"a":"\n"}',
    `{"a":"${u('dc00')}${u('d800')}"}`,
    `{"${u('d800')}":1}`,
    '{"a":1}{"b":2}',
    '{"a":1} x',
    '{"a":1\u{a0}}',
    '{"a":\u{2028}1}',
    '{"a":"\\',
    '{"a":',
    '{',
  ])
    assert.equal(readContainer(text), null, JSON.stringify(text));
});

test('audit U1b guard: nesting may reach 32 levels and not 33', () => {
  const base = JSON.stringify({
    type: 'boopy.activity',
    version: 1,
    binding: { requestId: 'arq_audit1', packageId: 'ctx_audit1', packetSha256: 'a'.repeat(64) },
    fallbackText: 'Synthetic fallback.',
    activity: { title: 'x' },
  });
  const nest = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
  // The file object is level 1 and the activity object level 2.
  assert.equal(readActivityFile(base.replace('"title"', `"x":${nest(30)},"title"`)).kind, 'read');
  assert.equal(
    readActivityFile(base.replace('"title"', `"x":${nest(31)},"title"`)).kind,
    'unreadable',
  );
});

test('audit U1b guard: Object.prototype method names as keys never throw', () => {
  const body = () => ({
    title: 'Camel and tent',
    purpose: 'Synthetic practice.',
    instruction: { text: 'Place them.', language: 'en' },
    components: [
      {
        type: 'arrange',
        axis: { kind: 'viewer-left-right' },
        tokens: [
          { key: 'a', label: { text: 'camel', language: 'en' }, sourceId: null },
          { key: 'b', label: { text: 'tent', language: 'en' }, sourceId: null },
        ],
      },
    ],
  });
  const file = () => ({
    type: 'boopy.activity',
    version: 1,
    binding: { requestId: 'arq_audit1', packageId: 'ctx_audit1', packetSha256: 'a'.repeat(64) },
    fallbackText: 'Synthetic fallback.',
    activity: body(),
  });
  for (const key of ['hasOwnProperty', 'toString', 'valueOf', 'toJSON', 'isPrototypeOf', 'then'])
    for (const where of ['file', 'binding', 'activity', 'component', 'token', 'label', 'axis']) {
      const value = file();
      const component = value.activity.components[0];
      const token = component?.tokens[0];
      assert.ok(component && token);
      const targets: Record<string, Record<string, unknown>> = {
        file: value,
        binding: value.binding,
        activity: value.activity,
        component,
        token,
        label: token.label,
        axis: component.axis,
      };
      const target = targets[where];
      assert.ok(target);
      target[key] = 1;
      const read = readActivityFile(JSON.stringify(value));
      if (read.kind === 'read') {
        const result = validateActivityBody(read.file.activity, new Set());
        assert.equal(result.activity, null, `${key} at ${where} was accepted`);
      } else assert.equal(read.kind, 'invalid', `${key} at ${where}`);
    }
});

test('audit U1b guard: separation rounds the gap to 9 decimals', () => {
  assert.equal(relationOf({ a: 0, b: 0.0999999996 }, 'a', 'b'), 'left-of');
  assert.equal(relationOf({ a: 0, b: 0.0999999994 }, 'a', 'b'), 'unclear');
  assert.equal(relationOf({ a: 0.2, b: 0.3 }, 'a', 'b'), 'left-of');
  assert.equal(relationOf({ a: 0.8, b: 0.7 }, 'a', 'b'), 'right-of');
  assert.equal(orderOf({ a: 0, b: 0.0999999994 }, ['a', 'b']).ties, true);
  assert.equal(orderOf({ a: 0, b: 0.0999999996 }, ['a', 'b']).ties, false);
});

test('audit U1b guard: snapped numbers print without exponent or trailing zeros', () => {
  const activity = (axis: Record<string, number>) => {
    const result = validateActivityBody(
      {
        title: 'Synthetic estimate',
        purpose: 'Synthetic.',
        instruction: { text: 'Place your estimate.', language: 'en' },
        components: [
          {
            type: 'arrange',
            axis: { kind: 'number', ...axis },
            tokens: [{ key: 'a', label: { text: 'Value', language: 'en' }, sourceId: null }],
          },
        ],
      },
      new Set(),
    );
    assert.ok(result.activity, JSON.stringify(result.issues));
    return result.activity;
  };
  const digest = (axis: Record<string, number>, x: number) =>
    digestOf(activity(axis), { positions: { a: x }, chosen: [], hintsRevealed: 0 }).replace(
      ' | hints: 0 of 0',
      '',
    );
  assert.equal(digest({ min: 0, max: 0.001, step: 0.000001 }, 0.001), 'arrange: Value = 0.000001');
  assert.equal(digest({ min: 0, max: 1e9, step: 1e6 }, 1), 'arrange: Value = 1000000000');
  assert.equal(digest({ min: 0, max: 5, step: 0.25 }, 0.5), 'arrange: Value = 2.5');
  assert.equal(digest({ min: -10, max: 10, step: 0.5 }, 0.5), 'arrange: Value = 0');
  assert.equal(snapValue({ min: -10, max: 10, step: 0.5 }, 0.5), 0);
  assert.equal(Object.is(snapValue({ min: -10, max: 0, step: 5 }, 1), -0), false);
});

test('audit U1b: reading stays linear on 64 KiB of inner whitespace', () => {
  // The file reader shares the event loop with the headset API, so seconds here stall Boopy.
  for (const content of [
    `x${' '.repeat(64_000)}y`,
    `x${'\n'.repeat(64_000)}y`,
    `\`\`\`json\nx${' '.repeat(60_000)}y\n\`\`\``,
  ]) {
    const start = performance.now();
    assert.equal(readActivityFile(content).kind, 'unreadable');
    const elapsed = Math.round(performance.now() - start);
    assert.ok(elapsed < 250, `${elapsed} ms for ${JSON.stringify(content.slice(0, 12))}`);
  }
  assert.equal(readReplyFile(`x${' '.repeat(16)}y`).kind, 'unreadable');
});
