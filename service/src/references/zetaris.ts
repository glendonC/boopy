import { spawn } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

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
