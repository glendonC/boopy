/**
 * A local stand-in for the assistant side of docs/activity-contract.md, using Ollama on this Mac.
 *
 *   activity --request <request.json> --out <activity.json>
 *   reply --submission <submission.json> --out <reply.json>
 *
 * One model call per run, bounded by a deadline and never retried. The model writes only the
 * activity body and fallback text, or the reply and optional next activity. The probe itself
 * copies the binding (and the reply echo) from the input's respondWith and labels the author as
 * local Ollama, so nothing written here can pass for Grok Bot or claim another binding. It prints
 * sizes, hashes and timings, never file or model content. Importing it never calls a model.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_FILE_BYTES = 64 * 1024;
export const DEFAULT_MODEL = 'qwen3.6:35b-a3b-nvfp4';
export const DEFAULT_URL = 'http://127.0.0.1:11434';
export const DEFAULT_DEADLINE_MS = 180_000;
const TEMPERATURE = 0.2;
/** Generous for the largest reply the limits allow, and a bound on a runaway answer. */
const NUM_PREDICT = 8192;
/** Far above any answer the limits allow; bounds what a misbehaving server can make us hold. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Ollama's words when a model's engine cannot constrain output to a schema (service ollama.ts). */
const NO_STRUCTURED_OUTPUT = 'structured output is unavailable';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const ACTIVITY_SYSTEM =
  'Answer this exact Boopy activity request. Return only the activity and fallbackText fields; Boopy itself copies the binding and labels the author. Never claim the person mastered anything, and keep unknowns unknown.';
const REPLY_SYSTEM =
  'Answer this exact Boopy activity submission. Return only the reply and next fields, with next null when you offer no next activity; Boopy itself copies the binding and echo and labels the author. Never claim the person mastered anything, and keep unknowns unknown.';
/** Ollama's structured outputs guide recommends the schema in the prompt as well as in format. */
const SCHEMA_LEAD = 'Answer with one JSON object, and nothing else, that matches this JSON Schema:';

const REQUEST_ID = /^arq_[A-Za-z0-9_-]{1,64}$/;
const ACTIVITY_ID = /^act_[A-Za-z0-9_-]{1,64}$/;
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{1,64}$/;
const PACKAGE_ID = /^ctx_[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
/** With "Ollama " and " (local)" the author stays within the contract's 60 characters. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,44}$/;
/** What contract section 10a treats as a link, so the author label always imports. */
const LINKISH = /:\/\/|www\.|\b(?:javascript|data|mailto|file|tel|sms|vbscript):\S/i;

const USAGE = [
  'Usage: node probes/activity-local-tutor.mjs activity --request <request.json> --out <activity.json> [options]',
  '       node probes/activity-local-tutor.mjs reply --submission <submission.json> --out <reply.json> [options]',
  `Options: --model <name> (${DEFAULT_MODEL}), --url <loopback Ollama> (${DEFAULT_URL}),`,
  `         --deadline-ms <100 to 600000> (${DEFAULT_DEADLINE_MS}), --schema-in-prompt`,
].join('\n');

/** Why a run stopped: the outcome and reason are printed, the message goes to stderr. */
class Stop extends Error {
  constructor(outcome, reason, message, code) {
    super(message);
    this.outcome = outcome;
    this.reason = reason;
    this.code = code;
  }
}
const refuse = (reason, message) => new Stop('refused', reason, message, 2);
const fail = (outcome, reason, message) => new Stop(outcome, reason, message, 1);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const text = (max) => ({ type: 'string', minLength: 1, maxLength: max });
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const one = (value) => ({ enum: [value] });
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const list = (min, max, items) => ({ type: 'array', minItems: min, maxItems: max, items });
const LANGUAGE = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$' };
const TOKEN_KEY = { enum: ['a', 'b', 'c', 'd'] };
const BOUNDED = { type: 'number', minimum: -1e9, maximum: 1e9 };
const textItem = (textMax, glossMax) =>
  object({ text: text(textMax), language: LANGUAGE, gloss: nullable(text(glossMax)) });

/**
 * Contract section 2 as far as JSON Schema goes: lengths, counts, enums, the per-axis token
 * counts, a target only on viewer-left-right, and source IDs limited to the ones the input lists.
 * Key order, distinct target tokens, unique tile texts, one word per space tile, one component of
 * each type, the number axis step rule and the display rules stay with Boopy's importer.
 * The activity comes before fallbackText so the fallback is written about a finished activity.
 */
function activityBodySchema(sourceIds) {
  const sourceId = sourceIds.length === 0 ? { type: 'null' } : nullable({ enum: sourceIds });
  const tokens = (min, max) =>
    list(min, max, object({ key: TOKEN_KEY, label: textItem(24, 40), sourceId }));
  const arrange = (axis, [min, max], target) =>
    object({ type: one('arrange'), axis, tokens: tokens(min, max), target });
  const sequence = (joiner, max) =>
    object({
      type: one('sequence'),
      joiner: one(joiner),
      language: LANGUAGE,
      tiles: list(
        3,
        8,
        object({
          key: { enum: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'] },
          text: text(max),
        }),
      ),
    });
  const direction = { enum: ['left-of', 'right-of'] };
  return object({
    title: text(60),
    purpose: text(200),
    instruction: textItem(200, 240),
    components: list(1, 2, {
      anyOf: [
        arrange(
          object({ kind: one('viewer-left-right') }),
          [2, 2],
          nullable(object({ subject: TOKEN_KEY, relation: direction, object: TOKEN_KEY })),
        ),
        arrange(object({ kind: one('scale'), low: text(24), high: text(24) }), [2, 4], {
          type: 'null',
        }),
        arrange(
          object({
            kind: one('number'),
            min: BOUNDED,
            max: BOUNDED,
            step: { type: 'number', minimum: 0.000001, maximum: 2e9 },
            unit: nullable(text(12)),
          }),
          [1, 4],
          { type: 'null' },
        ),
        sequence('space', 24),
        sequence('list', 48),
      ],
    }),
    hints: list(0, 3, textItem(200, 240)),
  });
}

/** The `format` schema for activity mode: only what the model writes. */
export function activityAnswerSchema(sourceIds) {
  return object({ activity: activityBodySchema(sourceIds), fallbackText: text(800) });
}

/** The `format` schema for reply mode; next reuses the activity body under the same sources. */
export function replyAnswerSchema(sourceIds) {
  const point = object({
    about: { enum: ['overall', 'arrange', 'sequence', 'hints'] },
    text: text(300),
    language: LANGUAGE,
    gloss: nullable(text(300)),
  });
  return object({
    reply: object({ summary: textItem(300, 300), points: list(1, 4, point) }),
    next: nullable(object({ activity: activityBodySchema(sourceIds), fallbackText: text(800) })),
  });
}

/** The only author this probe writes: local Ollama and the exact model, never Grok. */
export function authorFor(model) {
  if (
    typeof model !== 'string' ||
    !MODEL_NAME.test(model) ||
    /grok/i.test(model) ||
    LINKISH.test(model)
  )
    throw refuse(
      'model-name',
      'Use an installed Ollama model name of at most 45 letters, digits and . _ : / - that does not mention Grok.',
    );
  return `Ollama ${model} (local)`;
}

function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        request: { type: 'string' },
        submission: { type: 'string' },
        out: { type: 'string' },
        model: { type: 'string', default: DEFAULT_MODEL },
        url: { type: 'string', default: DEFAULT_URL },
        'deadline-ms': { type: 'string', default: String(DEFAULT_DEADLINE_MS) },
        'schema-in-prompt': { type: 'boolean', default: false },
      },
    });
  } catch {
    throw refuse('usage', USAGE);
  }
  const { values, positionals } = parsed;
  const [mode, ...rest] = positionals;
  const input = mode === 'activity' ? values.request : values.submission;
  const other = mode === 'activity' ? values.submission : values.request;
  const usable = ['activity', 'reply'].includes(mode) && rest.length === 0 && input && values.out;
  if (!usable || other !== undefined) throw refuse('usage', USAGE);
  const deadline = values['deadline-ms'];
  const deadlineMs = Number(deadline);
  if (!/^\d+$/.test(deadline) || deadlineMs < 100 || deadlineMs > 600_000)
    throw refuse('usage', 'Use --deadline-ms with a whole number from 100 to 600000.');
  return {
    mode,
    input,
    out: values.out,
    model: values.model,
    url: loopbackOrigin(values.url),
    deadlineMs,
    schemaInPrompt: values['schema-in-prompt'],
  };
}

/** Local means loopback: anything else would send the file off this Mac. */
function loopbackOrigin(value) {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    /* refused below */
  }
  const plain =
    url !== null &&
    url.protocol === 'http:' &&
    LOOPBACK.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  if (!plain)
    throw refuse(
      'url-not-loopback',
      'Use a loopback Ollama address such as http://127.0.0.1:11434.',
    );
  return url.origin;
}

/** A regular file, never a link, at most 64 KiB of well-formed UTF-8 holding one JSON object. */
async function readInput(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    const linked = await lstat(path).then(
      (info) => info.isSymbolicLink(),
      () => false,
    );
    if (linked)
      throw refuse('input-symlink', 'The input is a symbolic link. Pass the file itself.');
    throw refuse('input-unreadable', 'The input file cannot be opened.');
  }
  try {
    if (!(await handle.stat()).isFile())
      throw refuse('input-not-regular', 'The input is not a regular file.');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES)
      throw refuse('input-too-large', 'The input is larger than 64 KiB.');
    const raw = buffer.subarray(0, length);
    let decoded;
    try {
      // The decoder removes one leading byte order mark, as the contract's reader does.
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw refuse('input-not-utf8', 'The input is not well-formed UTF-8.');
    }
    let value;
    try {
      value = JSON.parse(decoded);
    } catch {
      // Parser messages quote the input, so they are never shown.
    }
    if (!isRecord(value)) throw refuse('input-not-json', 'The input is not one JSON object.');
    return { bytes: length, sha256: sha256(raw), text: decoded, value };
  } finally {
    await handle.close();
  }
}

/** Refuses before any model call when the output could not be written as a new file. */
async function checkOutput(path) {
  let existing = null;
  try {
    existing = await lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT')
      throw refuse('output-unusable', 'The output path cannot be used for a new file.');
  }
  if (existing !== null)
    throw refuse('output-exists', 'The output path already exists. Choose a new file name.');
  const folder = await stat(dirname(path)).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!folder) throw refuse('output-directory-missing', 'The output folder does not exist.');
}

function instructionsOf(value) {
  const { instructions } = value;
  if (
    !Array.isArray(instructions) ||
    instructions.length === 0 ||
    !instructions.every((line) => typeof line === 'string' && line.trim() !== '')
  )
    throw refuse('input-malformed', 'The input has no instructions to send.');
  return instructions;
}

/** Exactly the expected keys, each a string matching its pattern, copied in contract order. */
function bindingOf(value, shape) {
  const keys = Object.keys(shape);
  const exact =
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(
      (key) =>
        Object.hasOwn(value, key) && typeof value[key] === 'string' && shape[key].test(value[key]),
    );
  if (!exact) throw refuse('input-malformed', 'The respondWith binding is missing or malformed.');
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function activityTask(value) {
  if (value.type !== 'boopy.activity-request' || value.version !== 1)
    throw refuse('input-wrong-type', 'The input is not a version 1 Boopy activity request file.');
  const instructions = instructionsOf(value);
  const template = value.respondWith;
  if (!isRecord(template) || template.type !== 'boopy.activity' || template.version !== 1)
    throw refuse('input-malformed', 'The request has no boopy.activity respondWith template.');
  const binding = bindingOf(template.binding, {
    requestId: REQUEST_ID,
    packageId: PACKAGE_ID,
    packetSha256: SHA256,
  });
  const context = isRecord(value.context) ? value.context : {};
  if (
    binding.requestId !== value.requestId ||
    binding.packageId !== context.packageId ||
    binding.packetSha256 !== context.packetSha256
  )
    throw refuse('binding-mismatch', 'The respondWith binding does not match its own request.');
  const sources = value.sources;
  if (
    !Array.isArray(sources) ||
    !sources.every((source) => isRecord(source) && typeof source.sourceId === 'string')
  )
    throw refuse('input-malformed', 'The request has no readable sources list.');
  return {
    instructions,
    system: ACTIVITY_SYSTEM,
    schema: activityAnswerSchema([...new Set(sources.map((source) => source.sourceId))]),
    assemble(answer, author) {
      if (typeof answer.fallbackText !== 'string' || !isRecord(answer.activity))
        throw fail('unparsed', 'missing-fields', 'The answer lacked fallbackText or activity.');
      return {
        type: 'boopy.activity',
        version: 1,
        binding,
        author,
        fallbackText: answer.fallbackText,
        activity: answer.activity,
      };
    },
  };
}
