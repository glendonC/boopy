/**
 * Adversarial checks of U15e: `pnpm activity export` and `request` say "Wrote" only while the name
 * still holds the file they wrote. When another program removed or replaced that file, or put a
 * link there, the command exits 1 naming only the file, and leaves what is at the name, and
 * anything a link leads to, untouched. A fake loopback connector answers as the service would.
 * Where a volume gives a file another number once it holds data, as FAT32 and exFAT do, a file
 * nobody touched is still the command's own: it says Wrote, and a partial file is still removed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from '../activity-contract.ts';
import { exportSubmission, requestActivity } from '../cli/activity.ts';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'synthetic-audit-replaced-token';
const SUBMISSION = 'sub_auditreplaced1';
const EXPORTED = `boopy-activity-submission-${SUBMISSION}.json`;
const REQUEST_ID = 'arq_auditreplaced1';
const REQUESTED = `boopy-activity-request-${REQUEST_ID}.json`;
const CONTENT = '{"synthetic":"file rendered by the audit connector"}\n';
const OTHER = 'written by another program';
const OUTSIDE = 'synthetic outside file';
const EXPORT = ['export', '--submission', SUBMISSION];
const REQUEST = ['request', '--package', 'ctx_auditreplaced1', '--goal', 'Synthetic goal.'];

/** What the service answers: the rendered file on the two routes, else a refusal. */
function answerFor(url: string | undefined): [number, unknown] {
  const rendered = { fileSha256: sha256(CONTENT), file: CONTENT };
  if (url === `/v1/local-activities/submissions/${SUBMISSION}/export`)
    return [200, { submissionId: SUBMISSION, fileName: EXPORTED, ...rendered }];
  if (url === '/v1/local-activities/requests')
    return [200, { requestId: REQUEST_ID, fileName: REQUESTED, ...rendered }];
  return [404, { error: { code: 'not_found', message: 'Unknown route.' } }];
}

/** A loopback connector that holds each request until the test lets it answer. */
async function connector() {
  const held: [IncomingMessage, ServerResponse][] = [];
  let arrived: () => void = () => {};
  const asked = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    held.push([incoming, outgoing]);
    arrived();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    asked,
    answer() {
      for (const [incoming, outgoing] of held.splice(0)) {
        const [status, body] = answerFor(incoming.url);
        outgoing.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        outgoing.end(JSON.stringify(body));
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function folders() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-replaced-'));
  const dataDir = join(directory, 'data');
  const out = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(dataDir, 'connector-token'), TOKEN, { mode: 0o600 });
  await writeFile(join(directory, 'outside.json'), OUTSIDE);
  return { directory, dataDir, out };
}

/** Runs `pnpm activity` as its own process, optionally loading a module into it first. */
function run(args: string[], port: number, dataDir: string, out: string, preload?: string) {
  const child = spawn(
    process.execPath,
    [
      ...(preload === undefined ? [] : ['--import', pathToFileURL(preload).href]),
      'src/cli/activity.ts',
      ...args,
      '--out-dir',
      out,
      '--data-dir',
      dataDir,
      '--port',
      String(port),
    ],
    { cwd: SERVICE, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  // Close, unlike exit, waits until everything the command printed has been read.
  const closed = once(child, 'close');
  return {
    child,
    async finished() {
      const [code] = (await closed) as [number | null];
      return { code, stdout, stderr };
    },
  };
}

/** Nothing printed carries the token, a folder path or the file's content. */
function clean(printed: string, directory: string) {
  for (const secret of [TOKEN, directory, 'boopy-audit-replaced-', CONTENT.trim()])
    assert.equal(printed.includes(secret), false, 'the output carries a path, token or content');
}

type Change = (path: string, directory: string) => Promise<void>;

/** What another program does in the output folder while the service is being asked. */
const CHANGES: [string, Change][] = [
  ['nothing', async () => {}],
  [
    'its own file put at the name',
    async (path) => {
      await rm(path);
      await writeFile(path, OTHER, { mode: 0o600 });
    },
  ],
  ['the name removed', (path) => rm(path)],
  [
    'a link to an outside file put at the name',
    async (path, directory) => {
      await rm(path);
      await symlink(join(directory, 'outside.json'), path);
    },
  ],
  [
    'the folder moved away and a link to another folder holding the name put in its place',
    async (path, directory) => {
      const elsewhere = join(directory, 'elsewhere');
      await mkdir(elsewhere);
      await writeFile(join(elsewhere, EXPORTED), OTHER, { mode: 0o600 });
      await rename(dirname(path), join(directory, 'moved'));
      await symlink(elsewhere, dirname(path));
    },
  ],
];

test('audit U15e: an export says Wrote only while the name still holds the file it wrote', async () => {
  for (const [change, make] of CHANGES) {
    const { directory, dataDir, out } = await folders();
    const path = join(out, EXPORTED);
    const service = await connector();
    const command = run(EXPORT, service.port, dataDir, out);
    try {
      await service.asked;
      assert.equal((await lstat(path)).size, 0, 'the export claims its file before asking');
      await make(path, directory);
      service.answer();
      const { code, stdout, stderr } = await command.finished();
      clean(stdout + stderr, directory);
      assert.equal(await readFile(join(directory, 'outside.json'), 'utf8'), OUTSIDE, change);
      const first = stderr.split('\n')[0] ?? '';
      if (change === 'nothing') {
        assert.equal(code, 0, `${change}: ${first}`);
        assert.ok(stdout.startsWith(`Wrote ${EXPORTED} in the folder you chose`), change);
        assert.equal(await readFile(path, 'utf8'), CONTENT);
        assert.deepEqual(await readdir(out), [EXPORTED]);
      } else {
        assert.equal(stdout, '', `${change}: the export said it wrote a file it no longer holds`);
        assert.equal(code, 1, change);
        assert.ok(first.startsWith(`${EXPORTED} `), `${change}: ${first}`);
      }
      if (change === 'its own file put at the name') {
        assert.ok(first.startsWith(`${EXPORTED} was replaced by another program`), first);
        assert.ok(first.includes('The export is recorded'), first);
        assert.equal(await readFile(path, 'utf8'), OTHER);
        assert.deepEqual(await readdir(out), [EXPORTED]);
      }
      if (change === 'the name removed') assert.deepEqual(await readdir(out), [], change);
      if (change === 'a link to an outside file put at the name') {
        assert.ok((await lstat(path)).isSymbolicLink(), change);
        assert.equal(await readlink(path), join(directory, 'outside.json'));
        assert.deepEqual(await readdir(out), [EXPORTED]);
      }
      if (change.startsWith('the folder moved away')) {
        assert.ok((await lstat(out)).isSymbolicLink(), change);
        assert.equal(await readFile(join(directory, 'elsewhere', EXPORTED), 'utf8'), OTHER);
        assert.deepEqual(await readdir(join(directory, 'elsewhere')), [EXPORTED]);
      }
    } finally {
      if (command.child.exitCode === null) command.child.kill('SIGKILL');
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

/**
 * Loaded into the command's own process: the first time a file is synced, all of its bytes are
 * written, and another program has just removed the name and put its own file there.
 */
const replaceAtSync = (path: string) => `import { rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
const probe = await open(process.execPath, 'r');
const handles = Object.getPrototypeOf(probe);
await probe.close();
const syncAsUsual = handles.sync;
let replaced = false;
handles.sync = async function () {
  if (!replaced) {
    replaced = true;
    rmSync(${JSON.stringify(path)});
    writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(OTHER)}, { mode: 0o600 });
  }
  return syncAsUsual.call(this);
};
`;

test('audit U15e: export and request replaced after their last byte exit 1 and never say Wrote', async () => {
  for (const [args, name, advice] of [
    [EXPORT, EXPORTED, 'The export is recorded'],
    [REQUEST, REQUESTED, 'Request again'],
  ] as const) {
    for (const replaced of [false, true]) {
      const { directory, dataDir, out } = await folders();
      const preload = join(directory, 'replace-at-sync.mjs');
      await writeFile(preload, replaceAtSync(join(out, name)));
      const service = await connector();
      const command = run(args, service.port, dataDir, out, replaced ? preload : undefined);
      const label = `${args[0]}${replaced ? ' replaced' : ''}`;
      try {
        await service.asked;
        service.answer();
        const { code, stdout, stderr } = await command.finished();
        clean(stdout + stderr, directory);
        // Only the name is left in the folder: no probe file and no second copy.
        assert.deepEqual(await readdir(out), [name], label);
        const first = stderr.split('\n')[0] ?? '';
        if (replaced) {
          assert.equal(stdout, '', `${label}: it said it wrote a file another program replaced`);
          assert.equal(code, 1, label);
          assert.ok(first.startsWith(`${name} was replaced by another program`), first);
          assert.ok(first.includes(advice), first);
          assert.equal(await readFile(join(out, name), 'utf8'), OTHER, label);
        } else {
          assert.equal(code, 0, `${label}: ${first}`);
          assert.ok(stdout.startsWith(`Wrote ${name} in the folder you chose`), label);
          assert.equal(await readFile(join(out, name), 'utf8'), CONTENT, label);
        }
      } finally {
        if (command.child.exitCode === null) command.child.kill('SIGKILL');
        await service.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

/**
 * Until the returned function is called, this process sees regular files numbered the way FAT32
 * and exFAT volumes number them on macOS: an empty file has another number than it has once it
 * holds data, through its open handle and through its name alike (measured on such volumes: -6
 * when created, 9 once written). A file that holds data keeps its number.
 */
async function numberedLikeFat() {
  const probe = await open(process.execPath, 'r');
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const fs = createRequire(import.meta.url)('node:fs');
  const renumber = (stats: unknown) => {
    const info = stats as { isFile?: () => boolean; size: number | bigint; ino: number | bigint };
    if (info?.isFile?.() && Number(info.size) === 0)
      info.ino = typeof info.ino === 'bigint' ? -info.ino : -info.ino;
    return stats;
  };
  const wrap = (owner: Record<string, unknown>, key: string) => {
    const usual = owner[key] as (...args: unknown[]) => unknown;
    owner[key] = function (this: unknown, ...args: unknown[]) {
      const result = usual.apply(this, args);
      return result instanceof Promise ? result.then(renumber) : renumber(result);
    };
    return () => {
      owner[key] = usual;
    };
  };
  const restores = [
    wrap(handles, 'stat'),
    wrap(fs, 'lstatSync'),
    wrap(fs, 'fstatSync'),
    wrap(fs, 'statSync'),
    wrap(fs.promises, 'lstat'),
    wrap(fs.promises, 'stat'),
  ];
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores) restore();
    syncBuiltinESMExports();
  };
}

/** Until the returned function is called, every file write puts its first 16 bytes and fails. */
async function failWritesAfter16Bytes() {
  const probe = await open(process.execPath, 'r');
  const handles = Object.getPrototypeOf(probe);
  await probe.close();
  const writeFileAsUsual = handles.writeFile;
  handles.writeFile = async function (this: FileHandle, content: string) {
    await writeFileAsUsual.call(this, content.slice(0, 16), 'utf8');
    throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
  };
  return () => {
    handles.writeFile = writeFileAsUsual;
  };
}

/** Runs export or request in this process against a connector that answers once asked. */
async function inProcess(name: string, dataDir: string, out: string) {
  const service = await connector();
  try {
    const running =
      name === EXPORTED
        ? exportSubmission({ dataDir, port: service.port, submissionId: SUBMISSION, outDir: out })
        : requestActivity({
            dataDir,
            port: service.port,
            packageId: 'ctx_auditreplaced1',
            goal: 'Synthetic goal.',
            outDir: out,
          });
    await Promise.race([
      service.asked,
      running.then(
        () => {},
        () => {},
      ),
    ]);
    service.answer();
    return await running;
  } finally {
    await service.close();
  }
}

test('audit U15e: where a file is renumbered once it holds data, a finished file says Wrote', async () => {
  const { directory, dataDir, out } = await folders();
  const restore = await numberedLikeFat();
  try {
    const empty = join(directory, 'empty.json');
    await writeFile(empty, '');
    assert.ok(lstatSync(empty, { bigint: true }).ino < 0n, 'the stand-in numbering is not in use');
    for (const name of [EXPORTED, REQUESTED]) {
      const result = await inProcess(name, dataDir, out).catch((error: Error) =>
        assert.fail(`${name}: ${error.message}`),
      );
      assert.ok(result.message.startsWith(`Wrote ${name} in the folder you chose`), name);
      assert.equal(await readFile(join(out, name), 'utf8'), CONTENT, name);
    }
    // Both files are there, and the request's probe file is gone.
    assert.deepEqual((await readdir(out)).sort(), [EXPORTED, REQUESTED].sort());
  } finally {
    restore();
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit U15d and U15e: where a file is renumbered once it holds data, a partial file is removed', async () => {
  const { directory, dataDir, out } = await folders();
  const restoreNumbers = await numberedLikeFat();
  const restoreWrites = await failWritesAfter16Bytes();
  try {
    for (const name of [EXPORTED, REQUESTED]) {
      const failure = await inProcess(name, dataDir, out).then(
        () => assert.fail(`${name}: a failed write reported success`),
        (error: Error) => error.message,
      );
      assert.ok(
        failure.startsWith(`Could not finish writing ${name}, so it was removed.`),
        `${name}: ${failure}`,
      );
    }
    // Neither partial file nor the request's probe file is left.
    assert.deepEqual(await readdir(out), []);
  } finally {
    restoreWrites();
    restoreNumbers();
    await rm(directory, { recursive: true, force: true });
  }
});
