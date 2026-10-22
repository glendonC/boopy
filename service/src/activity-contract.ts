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
