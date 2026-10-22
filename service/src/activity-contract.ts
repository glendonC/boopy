/**
 * Arrange and sequence files (docs/activity-contract.md). Files carry proposed plain data.
 * Boopy assigns ids, revisions, and derived values. Nothing here decides whether an answer is
 * correct. The checks are a left/right relation, an order, and a snapped value.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evidenceRecords, evidenceSourceId, type Supersession } from './evidence-contract.ts';

export const MAX_FILE_BYTES = 64 * 1024;
/** Tokens closer than this along x have no relation and count as a tie. */
export const MIN_SEPARATION = 0.1;
const MAX_DEPTH = 32;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMBER_LIMIT = 1e9;
const MIN_STEP = 0.000001;
const MAX_DECIMALS = 6;
export const DIGEST_LIMIT = 400;
export const MAX_ISSUES = 8;
export const SCRIPT_MESSAGE = 'Boopy cannot display this script yet. Use Latin letters or Hangul.';

const identifier = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,64}$`), `Use a Boopy ${prefix}_ identifier.`);
export const RequestId = identifier('arq');
export const ActivityId = identifier('act');
export const SubmissionId = identifier('sub');
export const ReplyId = identifier('rep');
export const CallId = identifier('cal');
export const PackageId = z
  .string()
  .regex(/^ctx_[A-Za-z0-9_-]{1,128}$/, 'Use a Boopy ctx_ package identifier.');
export const PreparationRequestId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'Use a lowercase SHA-256 hex digest.');
export const LanguageTag = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/, 'Use a language tag such as en or ko.');

const LINE_BREAKS = /\r\n|[\r\u2028\u2029]/g;
const SINGLE_LINE = /[\n\r\u2028\u2029]/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const MARKUP = /[<>\uff1c\uff1e]/;
/** `scheme://`, `www.`, or a named scheme starting a word with a non-space after its colon. */
const LINK =
  /[a-z][a-z0-9+.-]*:\/\/|www\.|(?<![a-z0-9])(?:javascript|data|mailto|file|tel|sms|vbscript):(?=\S)/i;
const LATIN_OR_HANGUL = /[\p{Script=Latin}\p{Script=Hangul}]/u;
const COMMON_SIGN = /^\p{Script=Common}$/u;
const SIGN = /[\p{P}\p{S}\p{N}\p{Zs}]/u;
const MARK = /\p{M}/u;
/** Hangul filler characters render blank. */
const FILLER = /[\u115f\u1160\u3164\uffa0]/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

/**
 * What the headset's fonts render: printable ASCII, Latin and Hangul letters, and common
 * punctuation, digits, symbols and spaces. Never a combining mark left after NFC, a pictograph or
 * a code point above U+FFFF, so code-point and UTF-16 lengths agree. Digits, # and * stay allowed,
 * which is why the Emoji property is not used.
 */
function displayable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code > 0xffff || MARK.test(char) || PICTOGRAPHIC.test(char) || FILLER.test(char))
    return false;
  if (LATIN_OR_HANGUL.test(char)) return true;
  return COMMON_SIGN.test(char) && SIGN.test(char);
}

export function normalizeText(value: string, multiline = false): string {
  const normalized = value.normalize('NFC');
  return (multiline ? normalized.replace(LINE_BREAKS, '\n') : normalized).trim();
}

/** The first rule a normalized assistant string breaks, or null. */
export function textProblem(value: string, max: number, multiline = false): string | null {
  const chars = [...value];
  if (chars.length === 0) return 'Must not be empty.';
  if (chars.length > max) return `Use at most ${max} characters.`;
  if (!multiline && SINGLE_LINE.test(value)) return 'Use a single line.';
  const content = chars.filter((char) => char !== '\n');
  if (content.some((char) => CONTROL.test(char))) return 'Remove control characters.';
  if (MARKUP.test(value)) return 'Use plain text without markup.';
  if (LINK.test(value)) return 'Links are not allowed.';
  if (content.every((char) => /\s/u.test(char) || FILLER.test(char)))
    return 'Use at least one visible character.';
  if (!content.every(displayable)) return SCRIPT_MESSAGE;
  return null;
}

/** An assistant-supplied string: NFC, trimmed, bounded, plain and displayable. */
export function displayText(max: number, options: { multiline?: boolean } = {}) {
  const multiline = options.multiline ?? false;
  return z.string().transform((value, context) => {
    const text = normalizeText(value, multiline);
    const problem = textProblem(text, max, multiline);
    if (problem === null) return text;
    context.issues.push({ code: 'custom', message: problem, input: value });
    return z.NEVER;
  });
}

/** The person's own words: kept as written apart from NFC and trimming, one line, bounded. */
function personText(max: number) {
  return z.string().transform((value, context) => {
    const text = value.normalize('NFC').trim();
    const length = [...text].length;
    const problem =
      length === 0
        ? 'Must not be empty.'
        : length > max
          ? `Use at most ${max} characters.`
          : /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(text)
            ? 'Use a single line without control characters.'
            : null;
    if (problem === null) return text;
    context.issues.push({ code: 'custom', message: problem, input: value });
    return z.NEVER;
  });
}

export function textItem(textMax: number, glossMax: number) {
  return z.strictObject({
    text: displayText(textMax),
    language: LanguageTag,
    gloss: displayText(glossMax).nullish(),
  });
}
export type TextItem = { text: string; language: string; gloss?: string | null };

const TOKEN_KEYS = ['a', 'b', 'c', 'd'] as const;
export const TokenKey = z.enum(TOKEN_KEYS);
export type TokenKey = z.infer<typeof TokenKey>;
export const TileKey = z.string().regex(/^t[1-8]$/, 'Use tile keys t1 to t8.');
const Direction = z.enum(['left-of', 'right-of']);
export type Relation = 'left-of' | 'right-of' | 'unclear';

/**
 * Number axes are exact in integer micro-units: with at most 6 decimals and |value| at most 1e9,
 * every value is a whole number of millionths below 2^53.
 */
const MICRO = 1e6;
const micro = (value: number) => Math.round(value * MICRO);

/** Whole steps between min and max, or null when the step does not divide the range exactly. */
function stepsOf(axis: { min: number; max: number; step: number }): number | null {
  const range = micro(axis.max) - micro(axis.min);
  const step = micro(axis.step);
  return step > 0 && range > 0 && range % step === 0 ? range / step : null;
}

/** Decimal places of a number as JavaScript prints it, exponent form included. */
function decimals(value: number): number {
  const [mantissa = '', exponent = '0'] = String(value).toLowerCase().split('e');
  return Math.max(0, (mantissa.split('.')[1]?.length ?? 0) - Number(exponent));
}

const NumberAxis = z
  .strictObject({
    kind: z.literal('number'),
    min: z.number(),
    max: z.number(),
    step: z.number(),
    unit: displayText(12).nullish(),
  })
  .superRefine((axis, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    const large = (['min', 'max'] as const).filter((key) => Math.abs(axis[key]) > NUMBER_LIMIT);
    for (const key of large) issue(key, 'Use a number from -1000000000 to 1000000000.');
    const fine = (['min', 'max', 'step'] as const).filter(
      (key) => decimals(axis[key]) > MAX_DECIMALS,
    );
    for (const key of fine) issue(key, 'Use at most 6 decimal places.');
    if (large.length > 0 || fine.length > 0) return;
    if (!(axis.min < axis.max)) return issue('max', 'Use a min below max.');
    if (!(axis.step >= MIN_STEP)) return issue('step', 'Use a step of at least 0.000001.');
    const steps = stepsOf(axis);
    if (steps === null)
      issue('step', 'Use a step that divides max minus min into a whole number of steps.');
    else if (steps > 1000) issue('step', 'Use at most 1000 steps between min and max.');
  });
export type NumberAxis = z.output<typeof NumberAxis>;

const Axis = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('viewer-left-right') }),
    z.strictObject({ kind: z.literal('scale'), low: displayText(24), high: displayText(24) }),
    NumberAxis,
  ],
  {
    error: (issue) =>
      issue.code === 'invalid_union'
        ? 'Boopy does not support this axis yet. Use viewer-left-right, scale or number.'
        : undefined,
  },
);

/** Source membership depends on the request, so the body schema is built per request. */
function bodySchema(sources: ReadonlySet<string>) {
  const Arrange = z
    .strictObject({
      type: z.literal('arrange'),
      axis: Axis,
      tokens: z
        .array(
          z.strictObject({
            key: TokenKey,
            label: textItem(24, 40),
            sourceId: z.string().max(300).nullable(),
          }),
        )
        .min(1)
        .max(4),
      target: z
        .strictObject({ subject: TokenKey, relation: Direction, object: TokenKey })
        .nullish(),
    })
    .superRefine((component, context) => {
      const issue = (path: (string | number)[], message: string) =>
        context.addIssue({ code: 'custom', path, message });
      component.tokens.forEach((token, index) => {
        if (token.key !== TOKEN_KEYS[index])
          issue(['tokens', index, 'key'], 'Use token keys a to d in order.');
        if (token.sourceId !== null && !sources.has(token.sourceId))
          issue(['tokens', index, 'sourceId'], 'Use a source ID from the request, or null.');
      });
      const count = component.tokens.length;
      const kind = component.axis.kind;
      if (kind === 'viewer-left-right' && count !== 2)
        issue(['tokens'], 'Use exactly two tokens on a viewer-left-right axis.');
      if (kind === 'scale' && count < 2) issue(['tokens'], 'Use two to four tokens on a scale.');
      const target = component.target;
      if (target === null || target === undefined) return;
      if (kind !== 'viewer-left-right') issue(['target'], 'Use no target on a scale or number.');
      else if (target.subject === target.object)
        issue(['target'], 'Use two different tokens in the target.');
      else if (
        !component.tokens.some((token) => token.key === target.subject) ||
        !component.tokens.some((token) => token.key === target.object)
      )
        issue(['target'], 'Use token keys from this component in the target.');
    });
  const Sequence = z
    .strictObject({
      type: z.literal('sequence'),
      joiner: z.enum(['space', 'list']),
      language: LanguageTag,
      tiles: z
        .array(z.strictObject({ key: TileKey, text: displayText(48) }))
        .min(3)
        .max(8),
    })
    .superRefine((component, context) => {
      const issue = (path: (string | number)[], message: string) =>
        context.addIssue({ code: 'custom', path, message });
      component.tiles.forEach((tile, index) => {
        if (tile.key !== `t${index + 1}`)
          issue(['tiles', index, 'key'], 'Use tile keys t1 to t8 in order.');
      });
      const texts = component.tiles.map((tile) => tile.text);
      if (new Set(texts).size !== texts.length) issue(['tiles'], 'Use unique tile texts.');
      if (component.joiner !== 'space') return;
      component.tiles.forEach((tile, index) => {
        if (/\s/u.test(tile.text))
          issue(['tiles', index, 'text'], 'Use one word per tile, without spaces.');
        else if ([...tile.text].length > 24)
          issue(['tiles', index, 'text'], 'Use at most 24 characters.');
      });
    });
  return z
    .strictObject({
      title: displayText(60),
      purpose: displayText(200),
      instruction: textItem(200, 240),
      components: z
        .array(
          z.discriminatedUnion('type', [Arrange, Sequence], {
            error: (issue) =>
              issue.code === 'invalid_union'
                ? 'Boopy does not support this component yet. Use arrange or sequence.'
                : undefined,
          }),
        )
        .min(1)
        .max(2),
      hints: z.array(textItem(200, 240)).max(3).default([]),
    })
    .superRefine((body, context) => {
      const types = body.components.map((component) => component.type);
      if (new Set(types).size !== types.length)
        context.addIssue({
          code: 'custom',
          path: ['components'],
          message: 'Use at most one of each component type.',
        });
    });
}
export type ActivityBody = z.output<ReturnType<typeof bodySchema>>;
export type Component = ActivityBody['components'][number];
export type ArrangeComponent = Extract<Component, { type: 'arrange' }>;
export type SequenceComponent = Extract<Component, { type: 'sequence' }>;

export type BodyResult =
  | { activity: ActivityBody; issues: [] }
  | { activity: null; issues: string[] };

/** Valid bodies become plain JSON; invalid or unsupported ones keep only their issues. */
export function validateActivityBody(
  input: unknown,
  sources: ReadonlySet<string>,
  path: readonly (string | number)[] = ['activity'],
): BodyResult {
  const parsed = bodySchema(sources).safeParse(input, { reportInput: true });
  if (parsed.success) return { activity: JSON.parse(JSON.stringify(parsed.data)), issues: [] };
  return { activity: null, issues: formatIssues(parsed.error.issues, path) };
}

const present = z.unknown().refine((value) => value !== undefined, 'Required.');

/** Section 2 envelope; `activity` is validated against the request's sources separately. */
export const ActivityFile = z.strictObject({
  type: z.literal('boopy.activity'),
  version: z.literal(1),
  binding: z.strictObject({ requestId: RequestId, packageId: PackageId, packetSha256: Sha256 }),
  author: displayText(60).nullish(),
  fallbackText: displayText(800, { multiline: true }),
  activity: present,
});
export type ActivityFile = z.output<typeof ActivityFile>;

const About = z.enum(['overall', 'arrange', 'sequence', 'hints']);
export const ReplyContent = z.strictObject({
  summary: textItem(300, 300),
  points: z
    .array(
      z.strictObject({
        about: About,
        text: displayText(300),
        language: LanguageTag,
        gloss: displayText(300).nullish(),
      }),
    )
    .min(1)
    .max(4),
});
export type ReplyContent = z.output<typeof ReplyContent>;

/** Section 7 envelope; `next.activity` is validated against the original request separately. */
export const ReplyFile = z.strictObject({
  type: z.literal('boopy.activity-reply'),
  version: z.literal(1),
  binding: z.strictObject({ submissionId: SubmissionId, activityId: ActivityId }),
  author: displayText(60).nullish(),
  /** Compared with the digest after whitespace normalization, never displayed. */
  echo: z.string().max(2000),
  reply: ReplyContent,
  next: z
    .strictObject({ fallbackText: displayText(800, { multiline: true }), activity: present })
    .nullish()
    .transform((next) => next ?? null),
});
export type ReplyFile = z.output<typeof ReplyFile>;

export type Container = 'json' | 'fenced-json';
export type FileRead<T> =
  | { kind: 'unreadable' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'read'; container: Container; artifactSha256: string; file: T };

export function readActivityFile(content: string): FileRead<ActivityFile> {
  return readFile(content, ActivityFile);
}

export function readReplyFile(content: string): FileRead<ReplyFile> {
  return readFile(content, ReplyFile);
}

function readFile<T>(content: string, schema: z.ZodType<T>): FileRead<T> {
  const found = readContainer(content);
  if (found === null) return { kind: 'unreadable' };
  const parsed = schema.safeParse(found.value, { reportInput: true });
  if (!parsed.success) return { kind: 'invalid', issues: formatIssues(parsed.error.issues, []) };
  return {
    kind: 'read',
    container: found.container,
    artifactSha256: sha256(content),
    file: parsed.data,
  };
}

/** Whitespace that may surround a file; a second byte order mark is not whitespace here. */
const SPACE = /[^\S\ufeff]/;

/** An anchored match for the leading run and an index scan for the trailing one: linear time. */
function trimSurrounding(text: string): string {
  const start = /^[^\S\ufeff]*/.exec(text)?.[0].length ?? 0;
  let end = text.length;
  while (end > start && SPACE.test(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * Well-formed content of at most 64 KiB in UTF-8 bytes. After one leading byte order mark and
 * surrounding whitespace are removed, the whole content is one JSON object; otherwise it holds
 * exactly one fenced block, labelled exactly json.
 */
export function readContainer(
  content: string,
): { container: Container; value: Record<string, unknown> } | null {
  if (!content.isWellFormed() || Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) return null;
  const text = trimSurrounding(content.startsWith('\ufeff') ? content.slice(1) : content);
  const whole = jsonObject(text);
  if (whole !== null) return { container: 'json', value: whole };
  const blocks = fencedBlocks(text);
  const block = blocks[0];
  if (blocks.length !== 1 || block?.info !== 'json' || !block.closed) return null;
  const inner = jsonObject(trimSurrounding(block.body));
  return inner === null ? null : { container: 'fenced-json', value: inner };
}

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = strictJson(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const ESCAPES = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * RFC 8259 JSON within Boopy's limits. JSON.parse keeps the last of duplicate keys, accepts
 * prototype keys, lone surrogate escapes and 1e999, and nests without bound; this refuses all of
 * them, recursing at most 32 levels.
 */
function strictJson(text: string): unknown {
  let at = 0;
  const fail = (): never => {
    throw new Error('Unreadable JSON.');
  };
  const skip = () => {
    while (' \t\n\r'.includes(text.charAt(at)) && at < text.length) at += 1;
  };
  const literal = <T>(word: string, result: T): T => {
    if (!text.startsWith(word, at)) fail();
    at += word.length;
    return result;
  };
  const string = (): string => {
    at += 1;
    let result = '';
    let start = at;
    for (;;) {
      if (at >= text.length) fail();
      const code = text.charCodeAt(at);
      if (code === 0x22) break;
      if (code < 0x20) fail();
      if (code !== 0x5c) {
        at += 1;
        continue;
      }
      result += text.slice(start, at);
      const escaped = text.charAt(at + 1);
      at += 2;
      if (escaped === 'u') {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
        result += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else result += ESCAPES.get(escaped) ?? fail();
      start = at;
    }
    result += text.slice(start, at);
    at += 1;
    return result.isWellFormed() ? result : fail();
  };
  const value = (depth: number): unknown => {
    skip();
    const char = text.charAt(at);
    if (char === '{' || char === '[') {
      if (depth > MAX_DEPTH) fail();
      at += 1;
      return char === '{' ? object(depth) : array(depth);
    }
    if (char === '"') return string();
    if (char === 't') return literal('true', true);
    if (char === 'f') return literal('false', false);
    if (char === 'n') return literal('null', null);
    JSON_NUMBER.lastIndex = at;
    const match = JSON_NUMBER.exec(text)?.[0] ?? fail();
    at += match.length;
    const number = Number(match);
    return Number.isFinite(number) ? number : fail();
  };
  const object = (depth: number) => {
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    skip();
    if (text.charAt(at) === '}') {
      at += 1;
      return result;
    }
    for (;;) {
      skip();
      if (text.charAt(at) !== '"') fail();
      const key = string();
      if (keys.has(key) || RESERVED_KEYS.has(key)) fail();
      keys.add(key);
      skip();
      if (text.charAt(at) !== ':') fail();
      at += 1;
      result[key] = value(depth + 1);
      skip();
      const next = text.charAt(at);
      at += 1;
      if (next === '}') return result;
      if (next !== ',') fail();
    }
  };
  const array = (depth: number) => {
    const result: unknown[] = [];
    skip();
    if (text.charAt(at) === ']') {
      at += 1;
      return result;
    }
    for (;;) {
      result.push(value(depth + 1));
      skip();
      const next = text.charAt(at);
      at += 1;
      if (next === ']') return result;
      if (next !== ',') fail();
    }
  };
  const result = value(1);
  skip();
  return at === text.length ? result : fail();
}

/** CommonMark fences: three or more backticks or tildes, closed by an equal or longer run. */
function fencedBlocks(text: string) {
  const blocks: { info: string; body: string; closed: boolean }[] = [];
  let open: { char: string; length: number; info: string; lines: string[] } | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (open === null) {
      const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      const fence = start?.[1] ?? '';
      const info = (start?.[2] ?? '').trim();
      if (!start || (fence.startsWith('`') && info.includes('`'))) continue;
      open = { char: fence.charAt(0), length: fence.length, info, lines: [] };
      continue;
    }
    const end = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
    if (end?.startsWith(open.char) && end.length >= open.length) {
      blocks.push({ info: open.info, body: open.lines.join('\n'), closed: true });
      open = null;
    } else open.lines.push(line);
  }
  if (open) blocks.push({ info: open.info, body: open.lines.join('\n'), closed: false });
  return blocks;
}

/** Issues are Boopy's words; anything echoed from a file is cleaned and clipped first. */
function formatIssues(issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[]) {
  return issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = [...prefix, ...issue.path].map(String).join('.') || 'file';
    return clip(clean(`${path}: ${messageOf(issue)}`), 200);
  });
}

function messageOf(issue: z.core.$ZodIssue): string {
  const items = (count: number | bigint) => `${count} item${Number(count) === 1 ? '' : 's'}`;
  switch (issue.code) {
    case 'unrecognized_keys': {
      // A key name is repeated only when it cannot carry a link or hidden characters.
      const named = issue.keys
        .slice(0, 3)
        .map((key) => (/^[A-Za-z0-9_-]{1,40}$/.test(key) ? `"${key}"` : '(unprintable key)'));
      const more = issue.keys.length > 3 ? ` and ${issue.keys.length - 3} more` : '';
      return issue.keys.length === 1
        ? `Remove the unsupported field ${named[0]}.`
        : `Remove the unsupported fields ${named.join(', ')}${more}.`;
    }
    case 'invalid_type':
      return issue.input === undefined ? 'Required.' : issue.message;
    case 'too_big':
      if (issue.origin === 'array') return `Use at most ${items(issue.maximum)}.`;
      if (issue.origin === 'string') return `Use at most ${issue.maximum} characters.`;
      return `Use a number no greater than ${issue.maximum}.`;
    case 'too_small':
      if (issue.origin === 'array') return `Use at least ${items(issue.minimum)}.`;
      if (issue.origin === 'string') return `Use at least ${issue.minimum} characters.`;
      return `Use a number no less than ${issue.minimum}.`;
    default:
      return issue.message;
  }
}

function clean(value: string): string {
  return [...value]
    .map((char) => (char === '<' || char === '>' || !displayable(char) ? '?' : char))
    .join('');
}

function clip(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A position per token: null until placed, else x from 0 (your left, low, min) to 1. */
export type Positions = Readonly<Record<string, number | null>>;

const placedAt = (positions: Positions, key: string) => {
  const x = positions[key];
  return typeof x === 'number' ? x : null;
};

/** |dx| rounded to 9 decimals, so 0.3 - 0.2 counts as exactly 0.10 apart. */
const apart = (a: number, b: number) => Math.round(Math.abs(a - b) * 1e9) / 1e9 >= MIN_SEPARATION;

/** From the person's own view: whether the subject sits left or right of the object. */
export function relationOf(positions: Positions, subject: string, object: string): Relation | null {
  const from = placedAt(positions, subject);
  const to = placedAt(positions, object);
  if (from === null || to === null) return null;
  if (!apart(from, to)) return 'unclear';
  return from < to ? 'left-of' : 'right-of';
}

/** Placed keys by ascending x (ties keep key order); `ties` when neighbours are too close. */
export function orderOf<Key extends string>(positions: Positions, keys: readonly Key[]) {
  const placed = keys.filter((key) => placedAt(positions, key) !== null);
  const x = (key: Key) => placedAt(positions, key) ?? 0;
  const order = placed.sort((a, b) => x(a) - x(b) || keys.indexOf(a) - keys.indexOf(b));
  const ties = order.some((key, index) => {
    const previous = order[index - 1];
    return previous !== undefined && !apart(x(key), x(previous));
  });
  return { order, ties };
}

/**
 * `minU + k * stepU` micro-units with `k = Math.round(x * (maxU - minU) / stepU)`, so binary
 * noise never reaches a view, the journal or a digest.
 */
export function snapValue(
  axis: { min: number; max: number; step: number },
  x: number | null,
): number | null {
  if (x === null) return null;
  const minU = micro(axis.min);
  const stepU = micro(axis.step);
  const k = Math.round((x * (micro(axis.max) - minU)) / stepU);
  const snapped = (minU + k * stepU) / MICRO;
  return snapped === 0 ? 0 : snapped;
}

/** An exact decimal from whole micro-units, without exponent or trailing zeros. */
function formatNumber(value: number): string {
  const units = micro(value);
  const whole = Math.floor(Math.abs(units) / MICRO);
  const fraction = String(Math.abs(units) % MICRO)
    .padStart(6, '0')
    .replace(/0+$/, '');
  return `${units < 0 ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export type Derived = {
  relation: Relation | null;
  matchesTarget: boolean | null;
  order: TokenKey[];
  ties: boolean;
  values: Record<string, number | null> | null;
};

export function deriveArrangement(component: ArrangeComponent, positions: Positions): Derived {
  const keys = component.tokens.map((token) => token.key);
  const axis = component.axis;
  const target = component.target ?? null;
  const relation =
    axis.kind === 'viewer-left-right'
      ? relationOf(positions, target?.subject ?? 'a', target?.object ?? 'b')
      : null;
  return {
    relation,
    matchesTarget: target === null ? null : relation === target.relation,
    ...orderOf(positions, keys),
    values:
      axis.kind === 'number'
        ? Object.fromEntries(keys.map((key) => [key, snapValue(axis, placedAt(positions, key))]))
        : null,
  };
}

export function sequenceText(component: SequenceComponent, chosen: readonly string[]): string {
  return chosen
    .map((key) => component.tiles.find((tile) => tile.key === key)?.text ?? '')
    .join(component.joiner === 'space' ? ' ' : '; ');
}

/**
 * Boopy decides the order tiles are shown in: ascending SHA-256 of `<activityId>:<tileKey>`, so
 * the bank never reveals an answer order the assistant happened to write. Keys stay the file's.
 */
export function tileDisplayOrder<Tile extends { key: string }>(
  activityId: string,
  tiles: readonly Tile[],
): Tile[] {
  return tiles
    .map((tile) => ({ tile, rank: sha256(`${activityId}:${tile.key}`) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .map((entry) => entry.tile);
}

export function arrangeOf(activity: ActivityBody): ArrangeComponent | null {
  return activity.components.find((component) => component.type === 'arrange') ?? null;
}

export function sequenceOf(activity: ActivityBody): SequenceComponent | null {
  return activity.components.find((component) => component.type === 'sequence') ?? null;
}

/**
 * One line of at most 400 characters, parts joined by " | ". Only the sequence quote is ever
 * shortened, with an ellipsis, so the arrangement and hint count always survive.
 */
export function digestOf(
  activity: ActivityBody,
  state: { positions: Positions | null; chosen: readonly string[]; hintsRevealed: number },
): string {
  const arrange = arrangeOf(activity);
  const sequence = sequenceOf(activity);
  const hints = `hints: ${state.hintsRevealed} of ${activity.hints.length}`;
  const render = (quote: string | null) =>
    [
      ...(arrange ? [arrangeDigest(arrange, state.positions ?? {})] : []),
      ...(sequence ? [quote === null ? 'sequence: (empty)' : `sequence: "${quote}"`] : []),
      hints,
    ].join(' | ');
  const text = sequence && state.chosen.length > 0 ? sequenceText(sequence, state.chosen) : null;
  const line = render(text);
  const over = [...line].length - DIGEST_LIMIT;
  if (over <= 0 || text === null) return clip(line, DIGEST_LIMIT);
  const chars = [...text];
  return clip(
    render(`${chars.slice(0, Math.max(0, chars.length - over - 1)).join('')}…`),
    DIGEST_LIMIT,
  );
}
