import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { matchKey, type TermRow, type TermSnapshot } from './wikidata.ts';

export const ZetarisReferenceAssociation = z.union([
  z.object({ conceptKey: z.literal('dune'), referenceId: z.literal('Q25391') }),
  z.object({ conceptKey: z.literal('desert'), referenceId: z.literal('Q8514') }),
  z.object({ conceptKey: z.literal('dromedary'), referenceId: z.literal('Q71516') }),
]);
const ReferenceId = z.enum(['Q25391', 'Q8514', 'Q71516']);

const Reference = z
  .object({
    referenceSourceId: z.string(),
    referenceId: ReferenceId,
    koreanTerm: z.string().min(1).max(256),
    englishGloss: z.string().min(1).max(256),
    referenceVersion: z.string().regex(/^\d{1,20}$/),
    updatedAt: z.iso.datetime(),
    referenceStatus: z.literal('external-unreviewed'),
    referenceUrl: z.string().url(),
    license: z.literal('CC0-1.0'),
  })
  .strict();
const Result = z
  .object({
    mode: z.literal('zetaris-runtime'),
    operation: z.literal('reference-lookup'),
    rows: z.array(Reference).length(1),
  })
  .strict();
export type ZetarisReferenceResult = z.infer<typeof Result>;
const FailurePhase = z.enum([
  'input',
  'credentials',
  'subprocess',
  'connect',
  'reference',
  'result',
]);
export class ZetarisReferenceError extends Error {
  readonly phase: z.infer<typeof FailurePhase>;
  constructor(phase: z.infer<typeof FailurePhase>, cancelled = false) {
    super(cancelled ? 'Zetaris reference lookup cancelled.' : 'Zetaris reference unavailable.');
    this.phase = FailurePhase.safeParse(phase).success ? phase : 'subprocess';
  }
}
type Execute = (options: {
  referenceId: string;
  credentialFile: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

/** One explicitly mapped public catalog reference; never uploads context or accepts caller SQL/hosts. */
export async function lookupZetarisReference(
  options: { referenceId: string; credentialFile: string; signal?: AbortSignal },
  execute: Execute = executeReference,
): Promise<ZetarisReferenceResult> {
  let phase: z.infer<typeof FailurePhase> = 'input';
  try {
    if (!ReferenceId.safeParse(options.referenceId).success || !isAbsolute(options.credentialFile))
      throw new Error();
    if (options.signal?.aborted) throw new Error();
    phase = 'credentials';
    const info = await lstat(options.credentialFile);
    if (!info.isFile() || info.mode & 0o077 || info.size > 4096) throw new Error();
    const lines = (await readFile(options.credentialFile, 'utf8')).split(/\r?\n/);
    if (
      lines[0] !== 'boopy-reference-1970-01-01@example.invalid' ||
      !lines[1] ||
      lines.slice(2).some(Boolean)
    )
      throw new Error();
    phase = 'subprocess';
    const raw = await execute({
      referenceId: options.referenceId,
      credentialFile: options.credentialFile,
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new Error();
    phase = 'result';
    const parsed = Result.parse(raw);
    const row = parsed.rows[0];
    if (
      !row ||
      row.referenceId !== options.referenceId ||
      row.referenceSourceId !== `wikidata:${options.referenceId}` ||
      row.referenceUrl !== `https://www.wikidata.org/wiki/${options.referenceId}`
    )
      throw new Error();
    return parsed;
  } catch (error) {
    throw new ZetarisReferenceError(
      error instanceof ZetarisReferenceError ? error.phase : phase,
      options.signal?.aborted === true,
    );
  }
}

function executeReference(options: {
  referenceId: string;
  credentialFile: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const runner = fileURLToPath(
      new URL('../../probes/zetaris/run-federation.mjs', import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [runner, options.credentialFile, 'reference', options.referenceId],
      {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          PATH: '/usr/bin:/bin',
          ...(process.env.BOOPY_PROBE_JDK && { BOOPY_PROBE_JDK: process.env.BOOPY_PROBE_JDK }),
          ...(process.env.BOOPY_PROBE_JAR && { BOOPY_PROBE_JAR: process.env.BOOPY_PROBE_JAR }),
        },
      },
    );
    let output = '';
    let boundedFailure = false;
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(() => {
      boundedFailure = true;
      stop();
    }, 80000);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 32768) {
        boundedFailure = true;
        stop();
      }
    });
    child.once('error', () => {
      cleanup();
      reject(new Error());
    });
    child.once('close', (code) => {
      cleanup();
      if (code !== 0 || boundedFailure || options.signal?.aborted) {
        // The runner has already removed vendor text. Retain only a fixed reference phase.
        try {
          const failure = JSON.parse(output);
          if (
            !boundedFailure &&
            !options.signal?.aborted &&
            code === 1 &&
            failure.mode === 'zetaris-runtime' &&
            failure.operation === 'reference' &&
            failure.outcome === 'failed' &&
            ['connect', 'reference'].includes(failure.stage)
          )
            return reject(new ZetarisReferenceError(failure.stage));
        } catch {
          /* Malformed output remains a generic subprocess failure. */
        }
        return reject(new Error());
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error());
      }
    });
  });
}

// The tables: a dated Wikidata snapshot and the practice record, both on this Mac's Zetaris.

const PRACTICE_USER = 'boopy-practice-1970-01-01@example.invalid';
const Qid = z.string().regex(/^Q[1-9][0-9]{0,11}$/);
const Language = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/);
const PracticeResult = z.enum(['heard', 'not-heard', 'unclear']);
/** The closed list of practice tables: the showcase record and the one checks write to. */
export const PracticeTable = z.enum(['practice_attempt', 'practice_check']);
export type PracticeTable = z.infer<typeof PracticeTable>;

/** One spoken answer as the practice table holds it: ids, a Q-id, a language, a result and a time. */
export const PracticeRow = z.strictObject({
  attemptId: z.string().regex(/^evt_[A-Za-z0-9_-]{1,64}$/),
  taskId: z.string().regex(/^tsk_[A-Za-z0-9_-]{1,64}$/),
  sourceId: z.string().regex(/^src_[A-Za-z0-9_-]{1,64}$/),
  referenceId: Qid,
  language: Language,
  result: PracticeResult,
  recognitionUncertain: z.literal(true),
  attemptedAt: z.iso.datetime(),
});
export type PracticeRow = z.infer<typeof PracticeRow>;

const Rows = z
  .array(PracticeRow)
  .max(500)
  .refine((rows) => new Set(rows.map((row) => row.attemptId)).size === rows.length);

export const TermPickRequest = z.strictObject({
  table: PracticeTable,
  targetLanguage: Language,
  personLanguage: Language,
  /** matchKey() of Boopy's guess, or empty when there is no guess to match. */
  matchKey: z.union([
    z.literal(''),
    z
      .string()
      .max(80)
      .regex(/^[\p{L}\p{M}\p{N}]+([ -][\p{L}\p{M}\p{N}]+)*$/u),
  ]),
  sourceId: z.string().regex(/^src_[A-Za-z0-9_-]{1,64}$/),
  recalled: z.array(Qid).max(8),
  excluded: z.array(z.string().regex(/^tsk_[A-Za-z0-9_-]{1,64}$/)).max(64),
  rows: Rows,
});
export type TermPickRequest = z.infer<typeof TermPickRequest>;

const Count = z.number().int().min(0).max(100000);
const Staged = z.strictObject({ tableRows: Count, journalRows: Count, restaged: z.boolean() });
const Ms = z.number().int().min(0).max(120000);
export const PickedRow = z.strictObject({
  referenceId: Qid,
  matched: z.enum(['subject', 'recalled']),
  matchedText: z.string().min(1).max(256).nullable(),
  term: z.string().min(1).max(256).nullable(),
  gloss: z.string().min(1).max(256).nullable(),
  description: z.string().min(1).max(256).nullable(),
  referenceSourceId: z.string(),
  revisionId: z.string().regex(/^[0-9]{1,20}$/),
  modifiedAt: z.iso.datetime(),
  retrievedAt: z.iso.datetime(),
  referenceUrl: z.string(),
  license: z.literal('CC0-1.0'),
  status: z.literal('external-unreviewed'),
  attempts: Count,
  notHeard: Count,
  onSource: Count,
  lastAt: z.iso.datetime().nullable(),
  lastResult: PracticeResult.nullable(),
  why: z.enum(['new', 'heard-before', 'not-heard-before', 'unclear-before']),
});
export type PickedRow = z.infer<typeof PickedRow>;
const PickResult = z.strictObject({
  mode: z.literal('zetaris-runtime'),
  operation: z.enum(['term-pick', 'term-pick-check']),
  practice: Staged,
  stageMs: Ms,
  pickMs: Ms,
  rows: z.array(PickedRow).max(9),
});
export type TermPickResult = z.infer<typeof PickResult>;
const StageResult = z.strictObject({
  mode: z.literal('zetaris-runtime'),
  operation: z.enum(['practice-stage', 'practice-stage-check']),
  practice: Staged,
  stageMs: Ms,
});
export type PracticeStageResult = z.infer<typeof StageResult>;

const PracticePhase = z.enum([
  'input',
  'credentials',
  'subprocess',
  'connect',
  'query',
  'result',
  'integrity',
]);
export class ZetarisPracticeError extends Error {
  readonly phase: z.infer<typeof PracticePhase>;
  constructor(phase: z.infer<typeof PracticePhase>, cancelled = false) {
    super(cancelled ? 'Zetaris practice cancelled.' : 'Zetaris practice unavailable.');
    this.phase = PracticePhase.safeParse(phase).success ? phase : 'subprocess';
  }
}

/** Each mode writes one fixed table in the runner; "-check" is the table checks write. */
type PracticeMode = 'term-pick' | 'practice-stage' | 'term-pick-check' | 'practice-stage-check';
type PracticeCall = {
  mode: PracticeMode;
  credentialFile: string;
  input: string;
  signal?: AbortSignal;
};
type ExecutePractice = (call: PracticeCall) => Promise<unknown>;

/**
 * One fixed term-pick-v1 call: the runner first rewrites the practice table whole if it differs from
 * the journal rows sent, then runs the one query. A row comes back only as the engine returned it,
 * checked against the request (a subject row's matched text folds to the request's key, a recalled
 * row is one the request named, subject rows come first, no Q-id repeats) and then against the
 * import Boopy keeps outside Zetaris: every reference field must be the imported one, and no
 * imported match may be missing. A mismatch is an integrity failure; the changed row is never used.
 */
export async function pickTerm(
  options: {
    request: unknown;
    credentialFile: string;
    snapshot: TermSnapshot;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  execute: ExecutePractice = executePractice,
): Promise<TermPickResult> {
  return practiceCall(options, 'term-pick', execute, (raw, request) => {
    const parsed = PickResult.parse(raw);
    if (parsed.operation !== modeFor('term-pick', request.table)) throw new Error();
    const subjects = parsed.rows.filter((row) => row.matched === 'subject');
    if (
      parsed.practice.journalRows !== request.rows.length ||
      new Set(parsed.rows.map((row) => row.referenceId)).size !== parsed.rows.length ||
      parsed.rows.some(
        (row, index) =>
          row.referenceSourceId !== `wikidata:${row.referenceId}` ||
          row.referenceUrl !== `https://www.wikidata.org/wiki/${row.referenceId}` ||
          row.notHeard > row.attempts ||
          row.onSource > row.attempts ||
          (row.matched === 'subject'
            ? index >= subjects.length ||
              row.matchedText === null ||
              matchKey(row.matchedText) !== request.matchKey
            : row.matchedText !== null || !request.recalled.includes(row.referenceId)),
      )
    )
      throw new Error();
    if (!matchesSnapshot(parsed, request, options.snapshot))
      throw new ZetarisPracticeError('integrity');
    return parsed;
  });
}

/** Whether every returned reference field is the imported one and no imported match is missing. */
function matchesSnapshot(
  result: TermPickResult,
  request: TermPickRequest,
  snapshot: TermSnapshot,
): boolean {
  const items = new Map<string, TermRow[]>();
  for (const row of snapshot.rows)
    items.set(row.reference_id, [...(items.get(row.reference_id) ?? []), row]);
  const matches = (rows: readonly TermRow[]) =>
    request.matchKey === ''
      ? []
      : rows
          .filter(
            (row) =>
              row.language === request.personLanguage &&
              (row.kind === 'label' || row.kind === 'alias') &&
              row.match_key === request.matchKey,
          )
          .map((row) => row.text);
  const text = (rows: readonly TermRow[], language: string, kind: string) =>
    rows.find((row) => row.language === language && row.kind === kind)?.text ?? null;
  for (const row of result.rows) {
    const rows = items.get(row.referenceId);
    const first = rows?.[0];
    if (rows === undefined || first === undefined) return false;
    const same = (other: TermRow) =>
      other.source_id === first.source_id &&
      other.revision_id === first.revision_id &&
      other.modified_at === first.modified_at &&
      other.retrieved_at === first.retrieved_at &&
      other.reference_url === first.reference_url &&
      other.license === first.license &&
      other.status === first.status;
    const matched = matches(rows);
    if (
      !rows.every(same) ||
      row.referenceSourceId !== first.source_id ||
      row.revisionId !== first.revision_id ||
      row.modifiedAt !== first.modified_at ||
      row.retrievedAt !== first.retrieved_at ||
      row.referenceUrl !== first.reference_url ||
      row.license !== first.license ||
      row.status !== first.status ||
      row.term !== text(rows, request.targetLanguage, 'label') ||
      row.gloss !== text(rows, request.personLanguage, 'label') ||
      row.description !== text(rows, request.personLanguage, 'description') ||
      (row.matched === 'subject'
        ? row.matchedText === null || !matched.includes(row.matchedText)
        : matched.length > 0)
    )
      return false;
  }
  // Nothing imported may be missing, unless the query's nine-row limit cut it.
  const expected = [...items]
    .filter(([id, rows]) => matches(rows).length > 0 || request.recalled.includes(id))
    .map(([id]) => id);
  const returned = new Set(result.rows.map((row) => row.referenceId));
  return result.rows.length === 9 || expected.every((id) => returned.has(id));
}

function modeFor(base: 'term-pick' | 'practice-stage', table: PracticeTable): PracticeMode {
  return table === 'practice_check' ? `${base}-check` : base;
}

/** Rewrites the practice table to the journal's rows when it differs, and reports the counts. */
export async function stagePractice(
  options: {
    table: unknown;
    rows: unknown;
    credentialFile: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  execute: ExecutePractice = executePractice,
): Promise<PracticeStageResult> {
  return practiceCall(
    {
      request: { table: options.table, rows: options.rows },
      credentialFile: options.credentialFile,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
    'practice-stage',
    execute,
    (raw, request) => {
      const parsed = StageResult.parse(raw);
      if (
        parsed.operation !== modeFor('practice-stage', request.table) ||
        parsed.practice.journalRows !== request.rows.length
      )
        throw new Error();
      return parsed;
    },
  );
}

const StageRequest = z.strictObject({ table: PracticeTable, rows: Rows });

async function practiceCall<Result, Mode extends 'term-pick' | 'practice-stage'>(
  options: { request: unknown; credentialFile: string; signal?: AbortSignal; timeoutMs?: number },
  mode: Mode,
  execute: ExecutePractice,
  check: (
    raw: unknown,
    request: Mode extends 'term-pick' ? TermPickRequest : z.infer<typeof StageRequest>,
  ) => Result,
): Promise<Result> {
  let phase: z.infer<typeof PracticePhase> = 'input';
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15000);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  try {
    const request = (mode === 'term-pick' ? TermPickRequest : StageRequest).parse(options.request);
    if (!isAbsolute(options.credentialFile) || signal.aborted) throw new Error();
    phase = 'credentials';
    const info = await lstat(options.credentialFile);
    if (!info.isFile() || info.mode & 0o077 || info.size > 4096) throw new Error();
    const lines = (await readFile(options.credentialFile, 'utf8')).split(/\r?\n/);
    if (lines[0] !== PRACTICE_USER || !lines[1] || lines.slice(2).some(Boolean)) throw new Error();
    phase = 'subprocess';
    const raw = await execute({
      mode: modeFor(mode, request.table),
      credentialFile: options.credentialFile,
      input: requestLines(request),
      signal,
    });
    if (signal.aborted) throw new Error();
    phase = 'result';
    return check(raw, request as never);
  } catch (error) {
    throw new ZetarisPracticeError(
      error instanceof ZetarisPracticeError ? error.phase : phase,
      options.signal?.aborted === true,
    );
  }
}

function requestLines(request: TermPickRequest | z.infer<typeof StageRequest>): string {
  const lines: string[] = [];
  if ('matchKey' in request) {
    lines.push(
      [
        'pick',
        request.targetLanguage,
        request.personLanguage,
        request.matchKey,
        request.sourceId,
      ].join('\t'),
    );
    for (const id of request.recalled) lines.push(`recall\t${id}`);
    for (const id of request.excluded) lines.push(`exclude\t${id}`);
  }
  for (const row of request.rows)
    lines.push(
      [
        'row',
        row.attemptId,
        row.taskId,
        row.sourceId,
        row.referenceId,
        row.language,
        row.result,
        String(row.recognitionUncertain),
        row.attemptedAt,
      ].join('\t'),
    );
  return `${[...lines, 'end'].join('\n')}\n`;
}

function executePractice(call: PracticeCall): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const runner = fileURLToPath(
      new URL('../../probes/zetaris/run-federation.mjs', import.meta.url),
    );
    const child = spawn(process.execPath, [runner, call.credentialFile, call.mode], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: {
        PATH: '/usr/bin:/bin',
        ...(process.env.BOOPY_PROBE_JDK && { BOOPY_PROBE_JDK: process.env.BOOPY_PROBE_JDK }),
        ...(process.env.BOOPY_PROBE_JAR && { BOOPY_PROBE_JAR: process.env.BOOPY_PROBE_JAR }),
      },
    });
    let output = '';
    let bounded = false;
    const stop = () => child.kill('SIGTERM');
    call.signal?.addEventListener('abort', stop, { once: true });
    if (call.signal?.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 65536) {
        bounded = true;
        stop();
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(call.input);
    child.once('error', () => {
      call.signal?.removeEventListener('abort', stop);
      reject(new Error());
    });
    child.once('close', (code) => {
      call.signal?.removeEventListener('abort', stop);
      if (bounded || call.signal?.aborted) return reject(new Error());
      try {
        const value = JSON.parse(output);
        if (code === 0) return resolve(value);
        // The runner has already removed vendor text. Keep only a fixed phase.
        if (
          code === 1 &&
          value.mode === 'zetaris-runtime' &&
          value.operation === call.mode &&
          value.outcome === 'failed'
        )
          return reject(new ZetarisPracticeError(value.stage === 'connect' ? 'connect' : 'query'));
      } catch {
        /* Malformed output stays a generic subprocess failure. */
      }
      reject(new Error());
    });
  });
}
