import { z } from 'zod';
import type { Box, Grounding, Item, Point, Relation, Scope } from '../contracts.ts';
import type { TextLine } from '../events.ts';

/**
 * What a model returns. Coordinates are on a 0 to 1000 grid over the full frame, origin at the
 * top-left: boxes as [x_min, y_min, x_max, y_max], points as [x, y]. This is the convention Meta
 * documents for Muse Spark and Qwen for its vision models.
 */
export const ModelChoice = z
  .object({
    kind: z.literal('choice'),
    prompt: z.string().trim().min(1).max(160),
    options: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(60),
          value: z.string().trim().min(1).max(240),
        }),
      )
      .min(2)
      .max(3),
  })
  .refine((choice) => choice.options.every((option) => option.label === option.value));
export const ModelOutput = z.object({
  // An invalid optional widget must never discard an otherwise valid text answer.
  choice: ModelChoice.nullable().optional().catch(null),
  /** Optional for old fixtures/providers. Always a proposal, never a Muse task result. */
  response: z.string().max(1200).nullable().optional(),
  /** Informational continuations, distinct from unresolved evidence questions and human facts. */
  followUps: z
    .array(z.object({ question: z.string().trim().min(1).max(120) }))
    .max(2)
    .nullable()
    .optional(),
  scope: z.enum(['object', 'region', 'text', 'scene']),
  referent: z.object({
    key: z.string().nullable(),
    basis: z.enum(['pointer', 'gaze', 'speech', 'scene']),
    alternatives: z.array(z.string()),
  }),
  intent: z.object({
    label: z.string(),
    statement: z.string(),
    kind: z.string(),
    targetLanguage: z.string().nullable(),
    confidence: z.number(),
  }),
  items: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      label: z.string(),
      gloss: z.string().nullable(),
      statement: z.string(),
      box: z.array(z.number()).nullable(),
      point: z.array(z.number()).nullable(),
      scene: z.boolean(),
      confidence: z.number(),
      why: z.string(),
    }),
  ),
  relations: z.array(
    z.object({ from: z.string(), to: z.string(), kind: z.string(), label: z.string().nullable() }),
  ),
  questions: z.array(z.object({ text: z.string(), about: z.string().nullable() })),
});
export type ModelOutput = z.infer<typeof ModelOutput>;

/** A choice augments exactly one visible question, never a second caption or hidden preface. */
export function choiceForResponse(output: Pick<ModelOutput, 'response' | 'choice'>) {
  const choice = ModelChoice.safeParse(output.choice);
  return choice.success && output.response?.trim() === choice.data.prompt ? choice.data : undefined;
}

type JsonSchema = { [key: string]: unknown };

/**
 * The output schema as JSON Schema in the strict form Meta's Model API requires: every object
 * closed and every property required. Length limits are left out; they are checked after parsing.
 */
export function outputJsonSchema(): JsonSchema {
  const schema = z.toJSONSchema(ModelOutput) as JsonSchema;
  delete schema.$schema;
  return strictify(schema);
}

function strictify(node: unknown): JsonSchema {
  if (Array.isArray(node)) return node.map(strictify) as unknown as JsonSchema;
  if (node === null || typeof node !== 'object') return node as JsonSchema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) out[key] = strictify(value);
  if (out.type === 'object' && out.properties !== undefined) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as JsonSchema);
  }
  return out;
}

/** Parses a model's text answer, tolerating a fenced code block around the JSON. */
export function parseModelText(text: string): ModelOutput {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new ModelOutputError('The model returned no JSON object.', text);
  let value: unknown;
  try {
    value = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new ModelOutputError('The model returned JSON that does not parse.', text);
  }
  let parsed = ModelOutput.safeParse(value);
  // Follow-ups are an optional extra, like a choice: a malformed list is dropped, never reshaped,
  // and the rest of the answer is checked as strictly as before.
  if (
    !parsed.success &&
    parsed.error.issues.every((issue) => issue.path[0] === 'followUps') &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
    parsed = ModelOutput.safeParse({ ...value, followUps: null });
  if (!parsed.success) {
    throw new ModelOutputError(
      `The model's JSON does not match: ${parsed.error.issues[0]?.message}`,
      text,
    );
  }
  return parsed.data.choice === undefined
    ? parsed.data
    : { ...parsed.data, choice: choiceForResponse(parsed.data) ?? null };
}

export class InterpretError extends Error {
  override name = 'InterpretError';
  readonly raw: string;

  constructor(message: string, raw: string) {
    super(message);
    this.raw = raw;
  }
}

/** The model answered, but not with JSON that matches the schema: worth one more try. */
export class ModelOutputError extends InterpretError {
  override name = 'ModelOutputError';
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** Grid values to unit values. Values already within 0 to 1 are taken as unit values. */
function toUnit(values: readonly number[]): number[] {
  const unit = values.every((value) => value >= 0 && value <= 1);
  return values.map((value) => clamp(unit ? value : value / 1000));
}

export function gridBox(values: readonly number[] | null): Box | null {
  if (values === null || values.length !== 4 || !values.every(Number.isFinite)) return null;
  const [a, b, c, d] = toUnit(values) as [number, number, number, number];
  const box = { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
  return (box.x1 - box.x0) * (box.y1 - box.y0) < 0.0001 ? null : box;
}

export function gridPoint(values: readonly number[] | null): Point | null {
  if (values === null || values.length !== 2 || !values.every(Number.isFinite)) return null;
  const [x, y] = toUnit(values) as [number, number];
  return { x, y };
}

const confidenceOf = (value: number) => clamp(value > 1 && value <= 100 ? value / 100 : value);

/** Whether a text line's middle lies inside a box: the line belongs to what the box holds. */
const holds = (box: Box, line: TextLine) => {
  const x = (line.box.x0 + line.box.x1) / 2;
  const y = (line.box.y0 + line.box.y1) / 2;
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
};

/** Levenshtein distance between two strings, by code point. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let previous = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[y.length] ?? 0;
}

/** Letters and digits only, lowercased, with each one's position in the original text. */
function letters(text: string): { chars: string[]; at: number[] } {
  const chars: string[] = [];
  const at: number[] = [];
  [...text].forEach((char, index) => {
    if (/[\p{L}\p{N}]/u.test(char)) {
      chars.push(char.toLowerCase());
      at.push(index);
    }
  });
  return { chars, at };
}

/**
 * The span of an OCR line that a model's label reads, found by approximate search over letters
 * and digits only, so punctuation and spacing never count as a difference; null when no span is
 * close enough to be the same text.
 */
export function writtenAs(label: string, line: string): string | null {
  const wanted = letters(label).chars.join('');
  const length = [...wanted].length;
  if (length === 0) return null;
  const { chars, at } = letters(line);
  const tolerance = Math.max(1, Math.floor(length * 0.2));
  let best: { start: number; size: number; distance: number } | null = null;
  for (let size = Math.max(1, length - tolerance); size <= length + tolerance; size += 1) {
    for (let start = 0; start + size <= chars.length; start += 1) {
      const distance = editDistance(wanted, chars.slice(start, start + size).join(''));
      if (
        distance <= tolerance &&
        (best === null ||
          distance < best.distance ||
          (distance === best.distance && size > best.size))
      ) {
        best = { start, size, distance };
      }
    }
  }
  if (best === null) return null;
  const original = [...line];
  const from = best.start === 0 ? 0 : (at[best.start] ?? 0);
  const last = best.start + best.size;
  let to = last === chars.length ? original.length : (at[last - 1] ?? original.length - 1) + 1;
  // Keep punctuation that closes the words, such as the full stop of a sentence.
  while (to < original.length && /[.!?,;:]/.test(original[to] ?? '')) to += 1;
  return original.slice(from, to).join('').trim();
}

/** The first word that differs between the text as written and the model's reading of it. */
function differingWord(written: string, read: string): [string, string] | null {
  const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
  const a = words(written);
  const b = words(read);
  if (a.length !== b.length) return null;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? '';
    const y = b[index] ?? '';
    if (x.toLowerCase() !== y.toLowerCase()) return [x, y];
  }
  return null;
}

/**
 * What OCR says an item's box holds. A label that reads one of those lines becomes the text as
 * written, because models silently correct imperfect text and OCR is the record. Only a difference
 * in letters or digits, never punctuation, becomes a question for the person.
 */
function asWritten(
  label: string,
  box: Box | null,
  lines: readonly TextLine[],
): { label: string; text: string[]; question: string | null } | null {
  if (box === null) return null;
  const held = lines.filter((line) => holds(box, line));
  if (held.length === 0) return null;
  for (const line of held) {
    const written = writtenAs(label, line.text);
    if (written === null) continue;
    const same = letters(written).chars.join('') === letters(label).chars.join('');
    if (same) return { label: written, text: [line.text], question: null };
    const word = differingWord(written, label);
    const question =
      word === null
        ? `The text says "${written}" but the model read "${label.trim()}". Is the text as written a mistake?`
        : `The text says "${word[0]}" where the model expected "${word[1]}". Is that a mistake in the text?`;
    return { label: written, text: [line.text], question };
  }
  return { label: label.trim(), text: held.slice(0, 12).map((line) => line.text), question: null };
}

export interface Normalized {
  readonly scope: Scope;
  readonly referentId: string | null;
  readonly intentId: string;
  readonly items: Item[];
  readonly relations: Relation[];
}

/**
 * The model's proposal as Boopy items: every item `proposed`, origin `model`, unit coordinates,
 * ids unique to this interpretation, and text items backed by the exact OCR lines they cover.
 */
export function normalize(
  output: ModelOutput,
  context: {
    readonly interpretationId: string;
    readonly observationId: string;
    readonly scope: 'auto' | 'scene';
    readonly text: readonly TextLine[];
  },
): Normalized {
  const ids = new Map<string, string>();
  const idFor = (key: string) => {
    const existing = ids.get(key);
    if (existing !== undefined) return existing;
    const slug =
      key
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'item';
    let id = `${context.interpretationId}.${slug}`;
    for (let n = 2; [...ids.values()].includes(id); n += 1)
      id = `${context.interpretationId}.${slug}-${n}`;
    ids.set(key, id);
    return id;
  };
  const grounding = (box: Box | null, point: Point | null, scene: boolean): Grounding => {
    if (!scene && box !== null) return { kind: 'box', observationId: context.observationId, box };
    if (!scene && point !== null)
      return { kind: 'point', observationId: context.observationId, point };
    return { kind: 'scene' };
  };
  const base = { origin: 'model' as const, status: 'proposed' as const, emphasis: false };

  const discrepancies: { about: string; text: string }[] = [];
  const items: Item[] = output.items.map((raw) => {
    const box = gridBox(raw.box);
    const point = gridPoint(raw.point);
    const id = idFor(raw.key);
    const written = raw.scene ? null : asWritten(raw.label, box, context.text);
    if (written?.question != null) discrepancies.push({ about: id, text: written.question });
    return {
      id,
      kind: raw.kind.trim().toLowerCase() || 'object',
      label: written?.label ?? raw.label.trim(),
      ...(raw.gloss !== null && raw.gloss.trim() !== '' && { gloss: raw.gloss.trim() }),
      statement: raw.statement.trim(),
      grounding: grounding(box, point, raw.scene),
      confidence: confidenceOf(raw.confidence),
      ...(raw.why.trim() !== '' && { why: raw.why.trim() }),
      ...(written !== null && { text: written.text }),
      interpretationId: context.interpretationId,
      ...base,
    };
  });

  const intent: Item = {
    id: `${context.interpretationId}.intent`,
    kind: 'goal',
    label: output.intent.label.trim(),
    statement: output.intent.statement.trim(),
    grounding: { kind: 'scene' },
    confidence: confidenceOf(output.intent.confidence),
    interpretationId: context.interpretationId,
    ...base,
  };

  const asked: { text: string; about: Item | undefined }[] = [
    ...output.questions.map((question) => ({
      text: question.text,
      about:
        question.about === null
          ? undefined
          : items.find((item) => item.id === ids.get(question.about ?? '')),
    })),
    ...discrepancies.map((d) => ({
      text: d.text,
      about: items.find((item) => item.id === d.about),
    })),
  ];
  const questions: Item[] = asked.map((question, index) => ({
    id: `${context.interpretationId}.question-${index + 1}`,
    kind: 'question',
    label: question.text.trim(),
    statement: question.text.trim(),
    grounding: question.about?.grounding ?? { kind: 'scene' },
    confidence: null,
    interpretationId: context.interpretationId,
    ...base,
  }));

  const known = new Set(items.map((item) => item.id));
  const relations: Relation[] = output.relations.flatMap((relation, index) => {
    const from = ids.get(relation.from);
    const to = ids.get(relation.to);
    if (from === undefined || to === undefined || !known.has(from) || !known.has(to)) return [];
    return [
      {
        id: `${context.interpretationId}.relation-${index + 1}`,
        from,
        to,
        kind: relation.kind,
        ...(relation.label !== null && { label: relation.label }),
      },
    ];
  });

  const referentKey = output.referent.key;
  const referentId = referentKey === null ? null : (ids.get(referentKey) ?? null);
  return {
    scope: context.scope === 'scene' ? 'scene' : output.scope,
    referentId: referentId !== null && known.has(referentId) ? referentId : null,
    intentId: intent.id,
    items: [intent, ...items, ...questions],
    relations,
  };
}
