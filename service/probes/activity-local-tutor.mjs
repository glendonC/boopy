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

function replyTask(value) {
  if (value.type !== 'boopy.activity-submission' || value.version !== 1)
    throw refuse(
      'input-wrong-type',
      'The input is not a version 1 Boopy activity submission file.',
    );
  const instructions = instructionsOf(value);
  const template = value.respondWith;
  if (!isRecord(template) || template.type !== 'boopy.activity-reply' || template.version !== 1)
    throw refuse(
      'input-malformed',
      'The submission has no boopy.activity-reply respondWith template.',
    );
  const binding = bindingOf(template.binding, {
    submissionId: SUBMISSION_ID,
    activityId: ACTIVITY_ID,
  });
  const echo = template.echo;
  if (typeof echo !== 'string' || echo.trim() === '' || [...echo].length > 800)
    throw refuse('input-malformed', 'The respondWith template has no usable echo.');
  if (
    binding.submissionId !== value.submissionId ||
    binding.activityId !== value.activityId ||
    echo !== value.digest
  )
    throw refuse(
      'binding-mismatch',
      'The respondWith binding or echo does not match its own submission.',
    );
  return {
    instructions,
    system: REPLY_SYSTEM,
    // A next activity may only use sources the submitted activity already used.
    schema: replyAnswerSchema(sourceIdsOf(value.activity?.body)),
    assemble(answer, author) {
      const next = answer.next ?? null;
      if (!isRecord(answer.reply) || (next !== null && !isRecord(next)))
        throw fail('unparsed', 'missing-fields', 'The answer lacked a reply object.');
      return {
        type: 'boopy.activity-reply',
        version: 1,
        binding,
        author,
        echo,
        reply: answer.reply,
        next,
      };
    },
  };
}

function sourceIdsOf(body) {
  const ids = new Set();
  const components = isRecord(body) && Array.isArray(body.components) ? body.components : [];
  for (const component of components)
    if (isRecord(component) && Array.isArray(component.tokens))
      for (const token of component.tokens)
        if (isRecord(token) && typeof token.sourceId === 'string') ids.add(token.sourceId);
  return [...ids];
}

const DURATIONS = {
  total_duration: 'totalMs',
  load_duration: 'loadMs',
  prompt_eval_duration: 'promptEvalMs',
  eval_duration: 'evalMs',
};
const COUNTS = { prompt_eval_count: 'promptTokens', eval_count: 'outputTokens' };

/** Ollama's numeric counters (nanoseconds become milliseconds); any other provider text is dropped. */
function recordMetrics(response, summary) {
  if (!isRecord(response)) return;
  for (const [name, key] of Object.entries(DURATIONS))
    if (Number.isFinite(response[name]) && response[name] >= 0)
      summary[key] = Math.round(response[name] / 100_000) / 10;
  for (const [name, key] of Object.entries(COUNTS))
    if (Number.isSafeInteger(response[name]) && response[name] >= 0) summary[key] = response[name];
  if (typeof response.done_reason === 'string' && /^[a-z_]{1,20}$/.test(response.done_reason))
    summary.doneReason = response.done_reason;
}

/** One JSON object, alone or in one json or unlabelled fence; the file is always plain JSON. */
function answerOf(content) {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```$/.exec(trimmed);
  try {
    const value = JSON.parse(fenced === null ? trimmed : (fenced[1] ?? ''));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The response body as text, read no further than MAX_RESPONSE_BYTES whether or not a length is
 * declared. Leaving the loop early cancels the body, which closes the connection; the call's
 * deadline still applies to every read.
 */
async function readCapped(response, summary) {
  const chunks = [];
  let total = 0;
  if (response.body !== null)
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        summary.responseBytes = total;
        throw fail(
          'response-too-large',
          null,
          'Ollama sent more than 32 MiB, so the rest was not read. Nothing was retried or written.',
        );
      }
      chunks.push(chunk);
    }
  summary.responseBytes = total;
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The run's single model call. Every failure stops the run; nothing is ever retried. */
async function chat(options, prompt, summary) {
  const body = JSON.stringify({
    model: options.model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
    ...(!options.schemaInPrompt && { format: prompt.schema }),
    stream: false,
    think: false,
    options: { temperature: TEMPERATURE, num_predict: NUM_PREDICT },
  });
  summary.requestBytes = bytes(body);
  summary.modelCalls = 1;
  const started = performance.now();
  let response;
  let received;
  try {
    response = await fetch(new URL('/api/chat', options.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(options.deadlineMs),
    });
    summary.status = response.status;
    received = await readCapped(response, summary);
  } catch (error) {
    if (error instanceof Stop) throw error;
    if (error?.name === 'TimeoutError')
      throw fail(
        'deadline',
        null,
        'The model call passed its deadline and was stopped. Nothing was retried or written.',
      );
    if (error?.cause?.code === 'ECONNREFUSED')
      throw fail(
        'ollama-unreachable',
        null,
        'Ollama is not answering at that loopback address. Nothing was written.',
      );
    throw fail(
      'ollama-error',
      'transport',
      'The model call failed in transport. Nothing was retried or written.',
    );
  } finally {
    summary.wallMs = Math.round(performance.now() - started);
  }
  if (!response.ok) {
    if (
      !options.schemaInPrompt &&
      response.status === 501 &&
      received.includes(NO_STRUCTURED_OUTPUT)
    )
      throw fail(
        'structured-output-unavailable',
        null,
        'Ollama says structured output is unavailable for this model (HTTP 501). Nothing was retried or written; run again with --schema-in-prompt to send the schema in the prompt only.',
      );
    throw fail(
      'ollama-error',
      null,
      `Ollama answered HTTP ${response.status}. Nothing was retried or written.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(received);
  } catch {
    throw fail(
      'unparsed',
      'not-ollama-json',
      'Ollama sent a response that is not JSON. Nothing was written.',
    );
  }
  recordMetrics(parsed, summary);
  const content = isRecord(parsed) && isRecord(parsed.message) ? parsed.message.content : undefined;
  if (typeof content !== 'string')
    throw fail('unparsed', 'no-content', 'Ollama sent no message content. Nothing was written.');
  summary.contentBytes = bytes(content);
  const answer = answerOf(content);
  if (answer === null)
    throw fail('unparsed', 'not-json', 'The answer is not one JSON object. Nothing was written.');
  return answer;
}

/** A new file only: never follows a link, never replaces anything, private to this account. */
async function writeNew(path, content) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP')
      throw fail(
        'output-exists',
        'appeared-during-call',
        'The output path appeared during the model call and was left untouched. Nothing was written.',
      );
    throw fail(
      'output-unwritable',
      null,
      'The output file could not be created. Nothing was written.',
    );
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

async function run(argv, summary) {
  const options = parseOptions(argv);
  Object.assign(summary, {
    mode: options.mode,
    model: options.model,
    url: options.url,
    schemaVia: options.schemaInPrompt ? 'prompt' : 'format',
    deadlineMs: options.deadlineMs,
    temperature: TEMPERATURE,
    numPredict: NUM_PREDICT,
    think: false,
  });
  const author = authorFor(options.model);
  const input = await readInput(options.input);
  summary.inputBytes = input.bytes;
  summary.inputSha256 = input.sha256;
  const task = options.mode === 'activity' ? activityTask(input.value) : replyTask(input.value);
  summary.instructions = task.instructions.length;
  await checkOutput(options.out);
  const schemaText = JSON.stringify(task.schema);
  // The prompt is the file's own instructions plus its exact content; the system line is ours.
  const prompt = {
    system: `${task.system}\n\n${SCHEMA_LEAD}\n${schemaText}`,
    user: `${task.instructions.join('\n')}\n\n${input.text}`,
    schema: task.schema,
  };
  summary.systemBytes = bytes(prompt.system);
  summary.promptBytes = bytes(prompt.user);
  summary.schemaBytes = bytes(schemaText);
  const answer = await chat(options, prompt, summary);
  const content = `${JSON.stringify(task.assemble(answer, author), null, 2)}\n`;
  if (bytes(content) > MAX_FILE_BYTES)
    throw fail(
      'unparsed',
      'too-large',
      'The assembled file would exceed 64 KiB. Nothing was written.',
    );
  await writeNew(options.out, content);
  summary.outputFile = basename(options.out);
  summary.outputBytes = bytes(content);
  summary.outputSha256 = sha256(content);
  summary.outcome = 'written';
}

/** Runs one invocation; returns the exit code (0 written, 1 failed, 2 refused before any call). */
export async function main(argv, io = process) {
  const summary = { probe: 'activity-local-tutor', mode: null, outcome: null, modelCalls: 0 };
  let code = 0;
  try {
    await run(argv, summary);
  } catch (error) {
    const stop =
      error instanceof Stop
        ? error
        : fail('failed', null, 'The local tutor probe failed. No file or model content is shown.');
    summary.outcome = stop.outcome;
    if (stop.reason !== null) summary.reason = stop.reason;
    code = stop.code;
    io.stderr.write(`${stop.message}\n`);
  }
  io.stdout.write(`${JSON.stringify(summary)}\n`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
