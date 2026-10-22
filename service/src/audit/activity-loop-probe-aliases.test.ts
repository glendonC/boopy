/**
 * Adversarial checks of the hardened activity loop probe (BACKEND U8b): every other spelling of
 * the service's own folder, and the private failure log. Temporary folders and kernel-chosen
 * ports only; a probe that missed a refusal would run in a temporary folder, never a real one.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROBE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'probes',
  'activity-loop.mjs',
);
type Loop = (options: {
  dataDir: string;
  headsetPort: number;
  connectorPort: number;
  log?: (line: string) => void;
}) => Promise<{ result: string }>;
const { runActivityLoop } = (await import(pathToFileURL(PROBE).href)) as { runActivityLoop: Loop };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address.port < 47900 || address.port > 47911);
  return address.port;
}

async function privateDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

/** Other paths that reach the same folder on this machine: case variants and the data volume. */
async function aliases(folder: string): Promise<string[]> {
  const inode = statSync(folder).ino;
  const real = await realpath(folder);
  const parent = dirname(folder);
  return [
    join(parent, '.BOOPY'),
    join(parent, '.Boopy'),
    `/System/Volumes/Data${real}`,
    `/System/Volumes/Data${folder}`,
  ].filter((path) => path !== folder && existsSync(path) && statSync(path).ino === inode);
}

test("audit U8b: every other path to the service's own folder is refused too", async () => {
  const home = await privateDir('boopy-audit-loop-alias-home-');
  const boopy = join(home, '.boopy');
  await mkdir(boopy, { mode: 0o700 });
  const configured = await privateDir('boopy-audit-loop-alias-configured-');
  const saved = { HOME: process.env.HOME, BOOPY_DATA_DIR: process.env.BOOPY_DATA_DIR };
  // config.ts defaults to join(homedir(), '.boopy'); a caller's BOOPY_DATA_DIR is its real folder.
  process.env.HOME = home;
  process.env.BOOPY_DATA_DIR = configured;
  try {
    for (const folder of [boopy, configured])
      for (const dataDir of [folder, await realpath(folder), ...(await aliases(folder))]) {
        const [headsetPort, connectorPort] = [await freePort(), await freePort()];
        await assert.rejects(
          runActivityLoop({ dataDir, headsetPort, connectorPort, log: () => {} }),
          /own folder/,
          dataDir,
        );
      }
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(home, { recursive: true, force: true });
    await rm(configured, { recursive: true, force: true });
  }
});

test('audit U8b guard: a failed step leaves its details only in a private log in the run folder', async () => {
  const dataDir = await privateDir('boopy-audit-loop-error-log-');
  const files = join(dataDir, 'files');
  const headsetPort = await freePort();
  let connectorPort = await freePort();
  while (connectorPort === headsetPort) connectorPort = await freePort();
  try {
    const failure = await runActivityLoop({
      dataDir,
      headsetPort,
      connectorPort,
      log: (line) => {
        if (line.includes('local handoff prepared')) chmodSync(files, 0o500);
      },
    }).then(
      () => null,
      (error: Error) => error.message,
    );
    assert.match(
      failure ?? '',
      /^The request step failed \(exit code \d+\); details are in probe-error\.log/,
    );
    const log = join(dataDir, 'probe-error.log');
    assert.equal((await stat(log)).mode & 0o777, 0o600);
    assert.match(await readFile(log, 'utf8'), /^request\n/);
  } finally {
    if (existsSync(files)) chmodSync(files, 0o700);
    await rm(dataDir, { recursive: true, force: true });
  }
});
