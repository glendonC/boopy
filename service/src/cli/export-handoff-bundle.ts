/** Exact locally prepared snapshot plus caller's task; never sends, launches apps or reads a journal. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readConnectorToken } from '../manual-handoff.ts';
import { exportPrepared } from './export-prepared.ts';

const PackageId = z.string().regex(/^ctx_[a-zA-Z0-9_-]{1,128}$/);
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const names = ['continue.txt', 'manifest.json', 'selected-context.txt'];
const Manifest = z
  .object({
    type: z.literal('boopy-recording-bundle'),
    version: z.literal(1),
    packageId: PackageId,
    requestId: Identifier,
    receiptId: Identifier,
    exportedAt: z.iso.datetime(),
    historicalSnapshot: z.literal(true),
    sourceStateAtExport: z.literal('unchanged'),
    delivery: z.literal('not-sent'),
    packetSha256: Hash,
    taskSha256: Hash,
  })
  .strict();
const Status = z.object({
  state: z.literal('prepared-local'),
  packageId: PackageId,
  requestId: Identifier,
  sourceState: z.enum(['unchanged', 'changed']),
  receipt: z.object({
    receiptId: Identifier,
    packageId: PackageId,
    requestId: Identifier,
    packetSha256: Hash,
    delivery: z.literal('not-sent'),
    historicalSnapshot: z.literal(true),
  }),
});
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
type Selection = { packageId: string; requestId: string; dataDir: string; port?: number };
function selection(input: Selection) {
  PackageId.parse(input.packageId);
  Identifier.parse(input.requestId);
  if (
    !Number.isInteger(input.port ?? 47901) ||
    (input.port ?? 47901) < 1 ||
    (input.port ?? 47901) > 65535
  )
    throw new Error();
}
async function status(input: Selection) {
  selection(input);
  const token = await readConnectorToken(input.dataDir);
  const response = await fetch(
    `http://127.0.0.1:${input.port ?? 47901}/v1/local-handoffs/${input.packageId}?request=${encodeURIComponent(input.requestId)}`,
    {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('content-type')?.startsWith('application/json')
  ) {
    await response.body?.cancel();
    throw new Error();
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 128 * 1024) throw new Error();
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel();
    throw new Error();
  } finally {
    reader.releaseLock();
  }
  const value = Status.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (
    value.packageId !== input.packageId ||
    value.requestId !== input.requestId ||
    value.receipt.packageId !== input.packageId ||
    value.receipt.requestId !== input.requestId
  )
    throw new Error();
  return value;
}
async function privateRead(path: string, maximum: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077 || info.size > maximum) throw new Error();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const value = await file.readFile();
    if (value.byteLength > maximum) throw new Error();
    return value;
  } finally {
    await file.close();
  }
}
async function writeNew(path: string, value: string) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function exportHandoffBundle(
  input: Selection & { outputDirectory: string; task: string },
) {
  try {
    selection(input);
    if (!input.task.trim() || input.task.length > 4000 || input.task.includes('\0'))
      throw new Error();
    const directory = resolve(input.outputDirectory);
    const parent = await lstat(dirname(directory));
    if (!parent.isDirectory() || parent.mode & 0o077) throw new Error();
    // A new directory avoids mixing the selected snapshot with unrelated attachments.
    await mkdir(directory, { mode: 0o700 });
    await exportPrepared({ ...input, output: join(directory, 'selected-context.txt') });
    const packet = await privateRead(join(directory, 'selected-context.txt'), 8 * 1024 * 1024);
    const current = await status(input);
    if (current.sourceState !== 'unchanged' || current.receipt.packetSha256 !== hash(packet))
      throw new Error();
    const continuation = `Task supplied by the person:\n${input.task}\n\nUse only the attached selected-context.txt as personal context. Preserve source IDs, exact person-authored words, corrections, proposed model claims and open questions. Do not treat model confidence as human verification or infer missing activities, transport or event times. State what you cannot verify. Cite the source IDs used in your answer. This is a historical local snapshot; delivery and later source currentness are not established by this file.\n`;
    const manifest = Manifest.parse({
      type: 'boopy-recording-bundle',
      version: 1,
      packageId: input.packageId,
      requestId: input.requestId,
      receiptId: current.receipt.receiptId,
      exportedAt: new Date().toISOString(),
      historicalSnapshot: true,
      sourceStateAtExport: 'unchanged',
      delivery: 'not-sent',
      packetSha256: hash(packet),
      taskSha256: hash(continuation),
    });
    await writeNew(join(directory, 'continue.txt'), continuation);
    await writeNew(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return {
      directory,
      packageId: input.packageId,
      requestId: input.requestId,
      files: names,
      packetSha256: manifest.packetSha256,
      externalDelivery: 'not-attempted' as const,
    };
  } catch {
    // Partial files remain private and visibly incomplete; never overwrite or auto-resend.
    throw new Error(
      'Bundle unavailable or incomplete. Keep the exact selection and check it before trying again. No delivery is claimed.',
    );
  }
}

export async function checkHandoffBundle(input: {
  directory: string;
  dataDir: string;
  port?: number;
}) {
  let manifest: z.infer<typeof Manifest>;
  try {
    const directory = resolve(input.directory);
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.mode & 0o077 ||
      JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(names)
    )
      throw new Error();
    manifest = Manifest.parse(
      JSON.parse((await privateRead(join(directory, 'manifest.json'), 16384)).toString('utf8')),
    );
    const packet = await privateRead(join(directory, 'selected-context.txt'), 8 * 1024 * 1024);
    const task = await privateRead(join(directory, 'continue.txt'), 32768);
    if (hash(packet) !== manifest.packetSha256 || hash(task) !== manifest.taskSha256)
      throw new Error();
  } catch {
    throw new Error('Bundle files failed their integrity check. No delivery is claimed.');
  }
  try {
    const current = await status({
      ...input,
      packageId: manifest.packageId,
      requestId: manifest.requestId,
    });
    const matches =
      current.receipt.receiptId === manifest.receiptId &&
      current.receipt.packetSha256 === manifest.packetSha256;
    return {
      packageId: manifest.packageId,
      requestId: manifest.requestId,
      sourceState: matches ? current.sourceState : 'mismatched',
      readyForReview: matches && current.sourceState === 'unchanged',
      externalDelivery: 'unverified' as const,
    };
  } catch {
    return {
      packageId: manifest.packageId,
      requestId: manifest.requestId,
      sourceState: 'unverified',
      readyForReview: false,
      externalDelivery: 'unverified' as const,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2).filter((value, index) => !(index === 0 && value === '--')),
      options: {
        package: { type: 'string' },
        request: { type: 'string' },
        'data-dir': { type: 'string' },
        'output-directory': { type: 'string' },
        task: { type: 'string' },
        check: { type: 'string' },
        port: { type: 'string' },
      },
    });
    if (!values['data-dir']) throw new Error();
    const common = {
      dataDir: values['data-dir'],
      ...(values.port ? { port: Number(values.port) } : {}),
    };
    if (values.check) {
      if (values.package || values.request || values.task || values['output-directory'])
        throw new Error();
      const result = await checkHandoffBundle({ ...common, directory: values.check });
      console.log(JSON.stringify(result));
      if (!result.readyForReview) process.exitCode = 1;
    } else {
      if (!values.package || !values.request || !values.task || !values['output-directory'])
        throw new Error();
      console.log(
        JSON.stringify(
          await exportHandoffBundle({
            ...common,
            packageId: values.package,
            requestId: values.request,
            task: values.task,
            outputDirectory: values['output-directory'],
          }),
        ),
      );
    }
  } catch {
    console.error(
      'Use export:bundle with explicit package, request, private data directory, new output directory and literal task; or --check BUNDLE. No delivery is claimed.',
    );
    process.exitCode = 1;
  }
}
