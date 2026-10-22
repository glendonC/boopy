/**
 * pnpm activity request|import|export|reply: the person's explicit local actions on the Mac,
 * through the authenticated local connector. Outputs are new 0600 files; inputs are regular
 * files of at most 64 KiB. Nothing here sends anything to an assistant, and nothing printed
 * carries the token, packet text or a private path.
 */
import { randomUUID } from 'node:crypto';
import { type BigIntStats, constants, fstatSync, lstatSync, unlinkSync } from 'node:fs';
import { type FileHandle, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  ActivityCallView,
  ActivityRequestInput,
  MAX_FILE_BYTES,
  sha256,
} from '../activity-contract.ts';
import { readConnectorToken } from '../manual-handoff.ts';

const RESPONSE_LIMIT = 32 * 1024 * 1024;
const PACKAGE_ID = /^ctx_[A-Za-z0-9_-]{1,128}$/;
const SUBMISSION_ID = /^sub_[A-Za-z0-9_-]{1,64}$/;
const PREPARATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Connection = { dataDir: string; port?: number };

/** A file this process created and holds open: where, and the name its stop message gives. */
type Created = { path: string; name: string | null; file: FileHandle };

/**
 * Files this process created and has not finished, removed if the command fails or is stopped:
 * an output file, named in the stop message, or the request command's private probe file.
 */
const unfinished = new Set<Created>();

const RenderedFile = z.object({
  fileName: z.string(),
  fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.string(),
});
const RequestAnswer = RenderedFile.extend({
  requestId: z.string().regex(/^arq_[A-Za-z0-9_-]{1,64}$/),
});
const ExportAnswer = RenderedFile.extend({ submissionId: z.string() });
const ImportAnswer = z.object({
  activityId: z.string().regex(/^act_[A-Za-z0-9_-]{1,64}$/),
  status: z.enum(['active', 'fallback-only']),
  issues: z.array(z.string()).max(8),
  duplicate: z.boolean(),
});
const ReplyAnswer = z.object({
  replyId: z.string().regex(/^rep_[A-Za-z0-9_-]{1,64}$/),
  submissionId: z.string().regex(/^sub_[A-Za-z0-9_-]{1,64}$/),
  activityId: z.string().regex(/^act_[A-Za-z0-9_-]{1,64}$/),
  nextActivityId: z
    .string()
    .regex(/^act_[A-Za-z0-9_-]{1,64}$/)
    .nullable(),
  nextStatus: z.enum(['active', 'fallback-only']).nullable(),
  duplicate: z.boolean(),
});

/** Explicit practice request, followed by read-only polling; it never retries the request. */
export async function askActivity(
  options: Connection & {
    packageId: string;
    goal: string;
    preparationRequestId?: string;
    personLanguage?: string;
    background?: string;
  },
) {
  const input = ActivityRequestInput.parse({
    packageId: options.packageId,
    goal: options.goal,
    ...(options.preparationRequestId === undefined
      ? {}
      : { preparationRequestId: options.preparationRequestId }),
    ...(options.personLanguage === undefined ? {} : { personLanguage: options.personLanguage }),
    ...(options.background === undefined ? {} : { background: options.background }),
  });
  const signal = AbortSignal.timeout(130_000);
  let view = ActivityCallView.parse(
    await call(options, '/v1/local-activities/practice-requests', input, 'POST', signal),
  );
  if (view.kind !== 'activity' || view.packageId !== input.packageId)
    throw new Error('The service answered for another practice call.');
  const callId = view.callId;
  let first = true;
  while (view.state === 'running' && !signal.aborted) {
    if (!first)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, 1000);
        signal.addEventListener('abort', finish, { once: true });
      });
    first = false;
    if (signal.aborted) break;
    try {
      view = ActivityCallView.parse(
        await call(options, `/v1/local-activities/calls/${callId}`, undefined, 'GET', signal),
      );
    } catch {
      return {
        message: 'Boopy could not read the practice call outcome. Check the call in Boopy.',
        exitCode: 1,
      };
    }
    if (view.callId !== callId || view.packageId !== input.packageId)
      throw new Error('The service answered for another practice call.');
  }
  if (view.state === 'running')
    return {
      message: 'Boopy is still waiting for practice. Check the call in Boopy.',
      exitCode: 1,
    };
  return {
    message:
      view.state === 'imported' && view.activityId
        ? `Practice ready in Boopy: ${view.activityId}`
        : (view.failure?.message ?? 'Boopy could not finish this practice call.'),
    exitCode: view.state === 'imported' ? 0 : 1,
  };
}

/** Writes boopy-activity-request-<requestId>.json into an existing folder. */
export async function requestActivity(
  options: Connection & {
    packageId: string;
    goal: string;
    outDir: string;
    preparationRequestId?: string;
    personLanguage?: string;
    background?: string;
  },
) {
  if (!PACKAGE_ID.test(options.packageId))
    throw new Error('Choose a saved Boopy package ID such as ctx_... Nothing was requested.');
  if (
    options.preparationRequestId !== undefined &&
    !PREPARATION_ID.test(options.preparationRequestId)
  )
    throw new Error('Choose a preparation ID of letters, digits, _ or -. Nothing was requested.');
  const folder = await reserve(options.outDir);
  try {
    const answer = RequestAnswer.parse(
      await call(options, '/v1/local-activities/requests', {
        packageId: options.packageId,
        goal: options.goal,
        ...(options.preparationRequestId === undefined
          ? {}
          : { preparationRequestId: options.preparationRequestId }),
        ...(options.personLanguage === undefined ? {} : { personLanguage: options.personLanguage }),
        ...(options.background === undefined ? {} : { background: options.background }),
      }),
    );
    checkFile(answer, `boopy-activity-request-${answer.requestId}.json`);
    await writeNew(
      folder.path,
      answer.fileName,
      answer.file,
      'Request again to get a new request file.',
    );
    return {
      requestId: answer.requestId,
      fileName: answer.fileName,
      fileSha256: answer.fileSha256,
      message: [
        `Wrote ${answer.fileName} in the folder you chose (sha256 ${answer.fileSha256.slice(0, 12)}). Boopy did not send it.`,
        'Attach it in your assistant chat and paste this beside it:',
        'This is a Boopy activity request. Please follow its instructions and reply with exactly one downloadable .json file.',
      ].join('\n'),
    };
  } finally {
    await folder.release();
  }
}

/** Imports an activity file the assistant returned. */
export async function importActivity(options: Connection & { file: string }) {
  const content = await readInput(options.file);
  const answer = ImportAnswer.parse(
    await call(options, '/v1/local-activities/imports', { content }),
  );
  const message = answer.duplicate
    ? `This file was imported before as ${answer.activityId}; nothing new was recorded.`
    : answer.status === 'active'
      ? `Imported ${answer.activityId} as an active activity. Open it in Boopy.`
      : [
          `Imported ${answer.activityId} as text only: Boopy shows its fallback text because of these issues:`,
          ...answer.issues.map((issue) => `- ${issue}`),
        ].join('\n');
  return { ...answer, message };
}

/**
 * Writes boopy-activity-submission-<submissionId>.json into an existing folder. The name is known
 * before the service is asked, so the file is claimed first: an existing file or link refuses the
 * export before a renewed export could be journaled for bytes the person never receives. A failed
 * or stopped export removes the file it created, so the next export into that folder can write it,
 * unless another process has put a file at that name since.
 */
export async function exportSubmission(
  options: Connection & { submissionId: string; outDir: string },
) {
  if (!SUBMISSION_ID.test(options.submissionId))
    throw new Error('Choose a submission ID such as sub_... Nothing was requested.');
  const fileName = `boopy-activity-submission-${options.submissionId}.json`;
  const own = await claim(
    join(await folder(options.outDir), fileName),
    fileName,
    `${fileName} already exists in that folder or cannot be created; existing files are never overwritten. Nothing was requested.`,
  );
  try {
    const answer = ExportAnswer.parse(
      await call(options, `/v1/local-activities/submissions/${options.submissionId}/export`),
    );
    if (answer.submissionId !== options.submissionId)
      throw new Error('The service answered for another submission. Nothing was written.');
    checkFile(answer, fileName);
    await fill(own, answer.file, {
      failed:
        'Boopy has recorded this export; exporting it into another folder gives exactly the recorded bytes.',
      replaced:
        'The export is recorded; export it again into another folder to get the recorded bytes.',
    });
    return {
      submissionId: answer.submissionId,
      fileName,
      fileSha256: answer.fileSha256,
      message: [
        `Wrote ${fileName} in the folder you chose (sha256 ${answer.fileSha256.slice(0, 12)}). Boopy did not send it.`,
        'Attach it in the same assistant chat and paste this beside it:',
        'This is my Boopy activity submission. Please reply with exactly one downloadable .json file as its instructions describe, and copy its echo exactly.',
      ].join('\n'),
    };
  } finally {
    // The file this command created is removed whenever its write did not finish, even when some
    // bytes reached it; a file another process has put at the name is never touched. This runs
    // before the handle is closed, so the file's inode cannot have been reused in between.
    removeUnfinished(own);
    await own.file.close();
  }
}

/** Imports a reply file; an optional next activity becomes a new activity in Boopy. */
export async function importReply(options: Connection & { file: string }) {
  const content = await readInput(options.file);
  const answer = ReplyAnswer.parse(
    await call(options, '/v1/local-activities/replies', { content }),
  );
  const next =
    answer.nextActivityId === null
      ? 'It has no next activity.'
      : `Next activity ${answer.nextActivityId} is ready${answer.nextStatus === 'fallback-only' ? ' as text only' : ''}.`;
  const message = answer.duplicate
    ? `This reply was imported before as ${answer.replyId}; nothing new was recorded. ${next}`
    : `Imported reply ${answer.replyId} for ${answer.submissionId} from a file claiming its author; Boopy has not verified it. ${next}`;
  return { ...answer, message };
}

function checkFile(answer: z.infer<typeof RenderedFile>, expectedName: string) {
  if (answer.fileName !== expectedName || sha256(answer.file) !== answer.fileSha256)
    throw new Error('The service returned an unexpected file. Nothing was written.');
}

const FOLDER_REFUSAL =
  'Choose an existing folder where Boopy can create a new private file. Nothing was requested.';

async function folder(outDir: string) {
  const path = resolve(outDir);
  const info = outDir.trim() ? await stat(path).catch(() => null) : null;
  if (!info?.isDirectory()) throw new Error(FOLDER_REFUSAL);
  return path;
}

/**
 * Proves the chosen folder takes a new private file before the service is asked for anything,
 * so nothing is disclosed for an output that cannot be written. Used when the final name comes
 * from the service; that name is created exclusively afterwards. The probe file is removed on
 * release, or when the command is stopped before then; its handle stays open until it is removed.
 */
async function reserve(outDir: string) {
  const path = await folder(outDir);
  const probe = await claim(
    join(path, `.boopy-activity-${randomUUID()}.partial`),
    null,
    FOLDER_REFUSAL,
  );
  return {
    path,
    release: async () => {
      removeUnfinished(probe);
      await probe.file.close();
    },
  };
}

/**
 * Creates a new private file at the path, never over an existing file or a link, and lists it as
 * unfinished with its open handle, by which cleanup tells it from a file another process puts at
 * the same name later.
 */
async function claim<Name extends string | null>(path: string, name: Name, refusal: string) {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new Error(refusal);
  }
  const own = { path, name, file };
  unfinished.add(own);
  return own;
}

/**
 * What the name holds now: the file this process created ('own'), another regular file ('other'),
 * no regular file ('none'), or 'unknown' when the name cannot be checked for another reason, such
 * as a folder that no longer lets it be looked up. The name is compared with the open handle at
 * this moment, not with numbers kept from creation, because some volumes (FAT32, exFAT) give a
 * file another number once it holds data. Asked only while the handle is open, so the file's
 * number cannot have been freed and given to another file.
 */
function atName(own: Created): 'own' | 'other' | 'none' | 'unknown' {
  let now: BigIntStats;
  try {
    now = lstatSync(own.path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'none' : 'unknown';
  }
  if (!now.isFile()) return 'none';
  try {
    const written = fstatSync(own.file.fd, { bigint: true });
    return now.dev === written.dev && now.ino === written.ino ? 'own' : 'other';
  } catch {
    return 'unknown';
  }
}

/**
 * Removes a file this process created and has not finished, but only while its name still holds
 * it; a file another process has put there since is left alone. Synchronous, so a stop cannot
 * fall between the check and the removal. Says what happened: 'removed', 'finished' when there
 * was nothing to remove, or what the name holds instead ('own' when the removal failed, and
 * 'unknown', with nothing removed, when the name could not be checked).
 */
function removeUnfinished(own: Created) {
  if (!unfinished.delete(own)) return 'finished';
  const now = atName(own);
  if (now !== 'own') return now;
  try {
    unlinkSync(own.path);
    return 'removed';
  } catch {
    return 'own';
  }
}

/**
 * Writes the content into an output file this process created, through its still open handle.
 * When the write does not finish, the file is removed if its name still holds it, and the error
 * says what happened; when the write finishes but the name no longer holds the file, the error
 * says so instead of the command reporting the file written. The advice follows each error.
 */
async function fill(
  own: Created & { name: string },
  content: string,
  advice: { failed: string; replaced: string },
) {
  try {
    await own.file.writeFile(content, 'utf8');
    await own.file.sync();
  } catch {
    const outcome = removeUnfinished(own);
    const after =
      outcome === 'removed'
        ? ', so it was removed'
        : outcome === 'other' || outcome === 'none'
          ? `, and ${own.name} is no longer the file Boopy wrote`
          : outcome === 'unknown'
            ? `, and Boopy could not confirm ${own.name} is the file it wrote`
            : '';
    throw new Error(
      [`Could not finish writing ${own.name}${after}.`, advice.failed].filter(Boolean).join(' '),
    );
  }
  unfinished.delete(own);
  const now = atName(own);
  if (now === 'other')
    throw new Error(
      `${own.name} was replaced by another program while Boopy was writing it. ${advice.replaced}`,
    );
  if (now === 'none')
    throw new Error(`${own.name} is no longer the file Boopy wrote. ${advice.replaced}`);
  if (now === 'unknown')
    throw new Error(`Boopy could not confirm ${own.name} is the file it wrote. ${advice.replaced}`);
}

async function writeNew(folderPath: string, name: string, content: string, replaced: string) {
  const own = await claim(
    join(folderPath, name),
    name,
    `${name} already exists in that folder or cannot be created; existing files are never overwritten.`,
  );
  try {
    await fill(own, content, { failed: '', replaced });
  } finally {
    await own.file.close();
  }
}

/** A regular file of at most 64 KiB of UTF-8, read at most one byte past the limit. */
async function readInput(path: string): Promise<string> {
  const refusal = () =>
    new Error('Choose a regular UTF-8 file of at most 64 KiB, not a link, folder or device.');
  let file: FileHandle;
  try {
    // Non-blocking, so a FIFO cannot hang the open; it is refused as not a regular file.
    file = await open(
      resolve(path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw refusal();
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw refusal();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw refusal();
    // Keep a byte order mark so the service hashes exactly the bytes of the file.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, total),
    );
  } catch {
    throw refusal();
  } finally {
    await file.close();
  }
}

async function call(
  connection: Connection,
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<unknown> {
  const port = connection.port ?? 47901;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Choose a valid local connector port.');
  const token = await readConnectorToken(connection.dataDir);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('Could not reach the local Boopy connector. Is the Boopy service running?');
  }
  let answer: unknown;
  try {
    answer = JSON.parse(await bounded(response));
  } catch {
    throw new Error('The local Boopy connector gave an unreadable answer. Nothing was written.');
  }
  if (!response.ok) throw refused(response.status, answer);
  return answer;
}

async function bounded(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new Error('Answer too large.');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The service's code, words and issues, cleaned of anything that is not plain printable text. */
function refused(status: number, answer: unknown): Error {
  const failure = z
    .object({
      error: z.object({
        code: z.string(),
        message: z.string(),
        issues: z.array(z.string()).optional(),
      }),
    })
    .safeParse(answer);
  if (!failure.success) return new Error(`Boopy refused this (${status}).`);
  const plain = (text: string) => text.replace(/[^\P{C}]/gu, '?').slice(0, 300);
  const { code, message, issues } = failure.data.error;
  const named = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'refused';
  return new Error(
    [
      `Boopy refused this (${status} ${named}): ${plain(message)}`,
      ...(issues ?? []).slice(0, 8).map((issue) => `- ${plain(issue)}`),
    ].join('\n'),
  );
}

const USAGE = `Usage:
  pnpm activity ask --package ctx_ID --goal "your goal" [--preparation REQUEST_ID] [--language en] [--background "your note"]
  pnpm activity request --package ctx_ID --goal "your goal" --out-dir FOLDER [--preparation REQUEST_ID] [--language en] [--background "your note"]
  pnpm activity import --file ACTIVITY.json
  pnpm activity export --submission sub_ID --out-dir FOLDER
  pnpm activity reply --file REPLY.json
Common options: --data-dir (default $BOOPY_DATA_DIR or ~/.boopy) and --port (default $BOOPY_CONNECTOR_PORT or 47901).`;

async function main(args: string[]) {
  const [command, ...rest] = args.filter((value, index) => !(index === 0 && value === '--'));
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      package: { type: 'string' },
      goal: { type: 'string' },
      preparation: { type: 'string' },
      language: { type: 'string' },
      background: { type: 'string' },
      'out-dir': { type: 'string' },
      file: { type: 'string' },
      submission: { type: 'string' },
      'data-dir': { type: 'string' },
      port: { type: 'string' },
    },
  });
  const port = values.port ?? process.env.BOOPY_CONNECTOR_PORT;
  const connection = {
    dataDir: values['data-dir'] ?? process.env.BOOPY_DATA_DIR ?? join(homedir(), '.boopy'),
    ...(port === undefined ? {} : { port: Number(port) }),
  };
  const required = (value: string | undefined, name: string) => {
    if (value === undefined) throw new Error(`Add --${name}.`);
    return value;
  };
  switch (command) {
    case 'ask':
      return askActivity({
        ...connection,
        packageId: required(values.package, 'package'),
        goal: required(values.goal, 'goal'),
        ...(values.preparation === undefined ? {} : { preparationRequestId: values.preparation }),
        ...(values.language === undefined ? {} : { personLanguage: values.language }),
        ...(values.background === undefined ? {} : { background: values.background }),
      });
    case 'request':
      return requestActivity({
        ...connection,
        packageId: required(values.package, 'package'),
        goal: required(values.goal, 'goal'),
        outDir: required(values['out-dir'], 'out-dir'),
        ...(values.preparation === undefined ? {} : { preparationRequestId: values.preparation }),
        ...(values.language === undefined ? {} : { personLanguage: values.language }),
        ...(values.background === undefined ? {} : { background: values.background }),
      });
    case 'import':
      return importActivity({ ...connection, file: required(values.file, 'file') });
    case 'export':
      return exportSubmission({
        ...connection,
        submissionId: required(values.submission, 'submission'),
        outDir: required(values['out-dir'], 'out-dir'),
      });
    case 'reply':
      return importReply({ ...connection, file: required(values.file, 'file') });
    default:
      throw new Error('Choose ask, request, import, export or reply.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A stopped command removes the files it created and has not finished, while their names still
  // hold them: an output file, so the next export into that folder is not refused, and the probe.
  // A file another process has put at such a name is left and not mentioned.
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      for (const own of unfinished)
        if (removeUnfinished(own) === 'removed' && own.name !== null)
          console.error(`Stopped before ${own.name} was finished, so it was removed.`);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  try {
    const result = await main(process.argv.slice(2));
    console.log(result.message);
    if ('exitCode' in result) process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The activity command failed.');
    console.error(USAGE);
    process.exitCode = process.argv.includes('ask') ? 2 : 1;
  }
}
