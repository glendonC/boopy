/**
 * pnpm task connect|request|reply: the person's own steps on the Mac for a reply from a connection
 * they named (docs/protocol.md, "A reply from a named connection"), through the authenticated
 * local connector. A request is a new 0600 file in the folder named; a reply is a regular file of
 * at most 16 KiB, never read through a link. Nothing here sends anything to an assistant, and
 * nothing printed carries the token, the nonce or a file's contents.
 */
import { randomBytes } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sha256 } from '../activity-contract.ts';
import { MAX_CONNECTION_FILE_BYTES } from '../interaction/connection-files.ts';
import { ConnectionId, TaskId } from '../interaction/contract.ts';
import { call, readInput, writeNew } from './activity.ts';

type Connection = { dataDir: string; port?: number };

const id = (prefix: string) => `${prefix}_${randomBytes(16).toString('hex')}`;

const Connected = z.object({ connectionId: z.string(), label: z.string() });
const Requested = z.object({
  requestId: z.string(),
  fileName: z.string(),
  fileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  file: z.string(),
});
const Answered = z.object({
  taskId: z.string(),
  revision: z.number(),
  reply: z.object({ connection: z.string() }),
});

const FOLDER_REFUSAL =
  'Choose an existing folder where Boopy can create a new private file. Nothing was requested.';

/** The person names a connection on the Mac, such as a chat with their own assistant. */
export async function connectTask(options: Connection & { label: string }) {
  const answer = Connected.parse(
    await call(options, '/v1/local-tasks/connections', {
      eventId: id('evt'),
      connectionId: id('con'),
      label: options.label,
    }),
  );
  return {
    ...answer,
    message: `Named the connection "${answer.label}" (${answer.connectionId}). Boopy cannot tell who answers through it.`,
  };
}

const Pending = z.strictObject({
  eventId: z.string().regex(/^evt_[a-f0-9_A-Za-z-]{1,64}$/),
  requestId: z.string().regex(/^trq_[A-Za-z0-9_-]{1,64}$/),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
});

/** The private file in the folder that holds a request's ids until its file is written. */
export function pendingName(taskId: string, connectionId: string): string {
  return `.boopy-request-${taskId}.${connectionId}.pending`;
}

/**
 * The request file for a task's current revision. The folder and the new file's name are checked
 * before anything is asked, and files are created exclusively, so nothing is overwritten. The ids
 * and nonce wait in a private pending file until the request file is written, so a run that stops
 * in between is finished by running the same command again: the Mac gives the same file back.
 */
export async function requestTask(
  options: Connection & { taskId: string; connectionId: string; outDir: string },
) {
  // The ids become part of a file name, so they are checked before any name is built.
  if (
    !TaskId.safeParse(options.taskId).success ||
    !ConnectionId.safeParse(options.connectionId).success
  )
    throw new Error(
      'Use a task id (tsk_...) and a connection id (con_...). Nothing was requested.',
    );
  const folder = resolve(options.outDir);
  // lstat, so a folder that is a symbolic link is refused rather than followed.
  const info = options.outDir.trim() ? await lstat(folder).catch(() => null) : null;
  if (!info?.isDirectory()) throw new Error(FOLDER_REFUSAL);
  const pendingFile = pendingName(options.taskId, options.connectionId);
  const pendingPath = join(folder, pendingFile);
  const kept = await lstat(pendingPath).catch(() => null);
  const ids = kept
    ? Pending.parse(JSON.parse(await readInput(pendingPath)))
    : { eventId: id('evt'), requestId: id('trq'), nonce: randomBytes(16).toString('hex') };
  const fileName = `boopy-request-${ids.requestId}.json`;
  if (await lstat(join(folder, fileName)).catch(() => null)) {
    if (!kept)
      throw new Error(
        `${fileName} is already in that folder; existing files are never overwritten.`,
      );
    // An earlier run wrote the file and stopped before it removed its ids.
    await unlink(pendingPath).catch(() => {});
    return {
      requestId: ids.requestId,
      fileName,
      message: `${fileName} is already in that folder from an earlier run, so nothing more was asked.`,
    };
  }
  if (!kept)
    await writeNew(folder, pendingFile, `${JSON.stringify(ids)}\n`, 'Nothing was requested.');
  let answer: z.infer<typeof Requested>;
  try {
    answer = Requested.parse(
      await call(options, '/v1/local-tasks/requests', {
        ...ids,
        taskId: options.taskId,
        connectionId: options.connectionId,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Only a refusal is final; anything else may have reached the Mac, so the ids stay for a rerun.
    if (!message.startsWith('Boopy refused this')) throw error;
    await unlink(pendingPath).catch(() => {});
    if (message.includes('request_unavailable'))
      throw new Error(
        `The request ${ids.requestId} was for an earlier revision of this task, so its file cannot be written again. Run this command again to ask about the task as it is now.`,
      );
    throw error;
  }
  if (
    answer.requestId !== ids.requestId ||
    answer.fileName !== fileName ||
    sha256(answer.file) !== answer.fileSha256
  )
    throw new Error('The service returned an unexpected file. Nothing was written.');
  await writeNew(
    folder,
    fileName,
    answer.file,
    `Run the same command again to write it; the request ${ids.requestId} is recorded on the Mac.`,
  );
  await unlink(pendingPath).catch(() => {});
  return {
    requestId: ids.requestId,
    fileName,
    fileSha256: answer.fileSha256,
    message: `Wrote ${fileName}. Attach it in your chat with that connection and save the reply file it sends back, then run pnpm task reply --file REPLY.json. Boopy did not send it.`,
  };
}

/** The reply file the person brought back; it counts only for the exact request it answers. */
export async function replyTask(options: Connection & { file: string }) {
  const content = await readInput(options.file);
  if (Buffer.byteLength(content, 'utf8') > MAX_CONNECTION_FILE_BYTES)
    throw new Error('Choose a reply file of at most 16 KiB. Nothing was recorded.');
  const answer = Answered.parse(await call(options, '/v1/local-tasks/replies', { content }));
  return {
    taskId: answer.taskId,
    revision: answer.revision,
    message: `The reply came back through "${answer.reply.connection}" for ${answer.taskId}, now at revision ${answer.revision}. It stays a proposal; Boopy cannot tell who wrote it, and nothing was sent.`,
  };
}

const USAGE = `Usage:
  pnpm task connect --label "your name for it"
  pnpm task request --task tsk_ID --connection con_ID --out-dir FOLDER
  pnpm task reply --file REPLY.json
Common options: --data-dir (default $BOOPY_DATA_DIR or ~/.boopy) and --port (default $BOOPY_CONNECTOR_PORT or 47901).`;

async function main(args: string[]) {
  const [command, ...rest] = args.filter((value, index) => !(index === 0 && value === '--'));
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      label: { type: 'string' },
      task: { type: 'string' },
      connection: { type: 'string' },
      'out-dir': { type: 'string' },
      file: { type: 'string' },
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
    case 'connect':
      return connectTask({ ...connection, label: required(values.label, 'label') });
    case 'request':
      return requestTask({
        ...connection,
        taskId: required(values.task, 'task'),
        connectionId: required(values.connection, 'connection'),
        outDir: required(values['out-dir'], 'out-dir'),
      });
    case 'reply':
      return replyTask({ ...connection, file: required(values.file, 'file') });
    default:
      throw new Error('Choose connect, request or reply.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log((await main(process.argv.slice(2))).message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The task command failed.');
    console.error(USAGE);
    process.exitCode = 1;
  }
}
