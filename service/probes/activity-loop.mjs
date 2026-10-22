/**
 * Synthetic end-to-end run of the assistant activity loop on a real, isolated Boopy service.
 *
 *   node probes/activity-loop.mjs [--headset-port 47910] [--connector-port 47911] [--data-root DIR]
 *
 * It starts src/main.ts with the fixture interpreter and no other provider on two loopback ports
 * (never 47900 or 47901, and never ports already in use) and a new private data directory, then
 * drives the headset API and the pnpm activity command: request, import, arrangement, sequence,
 * hint, a refused stale submit, submit, export, a reply with a next activity, the next activity
 * and the same reply again. It then restarts the service on the same journal and requires
 * identical views and no appended events. All content is synthetic and nothing is sent anywhere.
 * It prints check names, identifiers and the digest, never file content, the token or a path; a
 * failed step is reported by name and exit code, with details in probe-error.log in the run's
 * private folder. SIGINT and SIGTERM stop the service it started. Importing it starts nothing.
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const SERVICE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESERVED_PORTS = new Set([47900, 47901]);
const run = promisify(execFile);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Stop functions of the services this process started, so a signal can stop them too. */
const running = new Set();

/** True when nothing listens on the loopback port. */
export function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
}

/** Only what the service needs, so no provider setting or key from the caller's shell leaks in. */
function environment(dataDir, headsetPort, connectorPort) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    BOOPY_DATA_DIR: dataDir,
    BOOPY_PORT: String(headsetPort),
    BOOPY_CONNECTOR_PORT: String(connectorPort),
    BOOPY_INTERPRETER: 'fixture',
    BOOPY_SEGMENTER: 'none',
    BOOPY_SPEECH_OUTPUT: 'none',
    BOOPY_LIVE_SCENE: 'none',
    BOOPY_MEMORY: 'none',
    BOOPY_SEMANTIC_MEMORY: 'none',
    BOOPY_LOG: '0',
  };
}

/**
 * Whether a path is the real service's folder, ~/.boopy or the caller's BOOPY_DATA_DIR: by name,
 * or by device and inode whenever both exist, which also catches case variants on a
 * case-insensitive volume, the /System/Volumes/Data spelling and any other link to it.
 */
async function serviceFolder(path) {
  const folders = [resolve(homedir(), '.boopy')];
  if (process.env.BOOPY_DATA_DIR) folders.push(resolve(process.env.BOOPY_DATA_DIR));
  if (folders.includes(path)) return true;
  const here = await stat(path, { bigint: true }).catch(() => null);
  if (here === null) return false;
  for (const folder of folders) {
    const there = await stat(folder, { bigint: true }).catch(() => null);
    if (there !== null && there.dev === here.dev && there.ino === here.ino) return true;
  }
  return false;
}

/** Ours only: our child is alive, its journal is in our folder and its connector takes our token. */
async function ours(alive, dataDir, connectorPort) {
  if (!alive() || !existsSync(join(dataDir, 'journal.sqlite'))) return false;
  const token = (await readFile(join(dataDir, 'connector-token'), 'utf8').catch(() => '')).trim();
  if (!token) return false;
  // An unknown package is refused after authentication and discloses nothing.
  const response = await fetch(`http://127.0.0.1:${connectorPort}/v1/context/ctx_probe_identity`, {
    headers: { authorization: `Bearer ${token}` },
  });
  await response.body?.cancel();
  return response.status === 404 && alive();
}

async function startService(dataDir, headsetPort, connectorPort) {
  const log = await open(join(dataDir, 'service.log'), 'a', 0o600);
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: SERVICE,
    env: environment(dataDir, headsetPort, connectorPort),
    stdio: ['ignore', log.fd, log.fd],
  });
  const exited = new Promise((done) => child.once('exit', done));
  const alive = () => child.exitCode === null && child.signalCode === null;
  const stop = async () => {
    if (alive()) child.kill('SIGTERM');
    await exited;
    running.delete(stop);
  };
  running.add(stop);
  await log.close();
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (!alive()) break;
    try {
      const response = await fetch(`http://127.0.0.1:${headsetPort}/v1/health`);
      await response.body?.cancel();
      if (response.ok && (await ours(alive, dataDir, connectorPort))) return stop;
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  await stop();
  throw new Error(
    'The isolated Boopy service did not start; see service.log in the data directory.',
  );
}

/**
 * Runs the loop and a restart against a fresh service. `dataDir` must be the absolute, already
 * resolved path of an existing, empty, private (0700) directory that is not a link and not the
 * real service's folder; the service writes its journal there and the files go to `files/`.
 */
export async function runActivityLoop({ dataDir, headsetPort, connectorPort, log = console.log }) {
  for (const port of [headsetPort, connectorPort])
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || RESERVED_PORTS.has(port))
      throw new Error('Choose loopback ports from 1024 to 65535 other than 47900 and 47901.');
  if (headsetPort === connectorPort) throw new Error('Choose two different ports.');
  if (typeof dataDir !== 'string' || !isAbsolute(dataDir) || resolve(dataDir) !== dataDir)
    throw new Error(
      'Choose an absolute, already resolved data directory path, not a relative one.',
    );
  if (await serviceFolder(dataDir))
    throw new Error("Choose a data directory other than the Boopy service's own folder.");
  // lstat on a resolved path never follows a trailing slash into a linked folder.
  const info = await lstat(dataDir).catch(() => null);
  if (!info?.isDirectory() || (info.mode & 0o777) !== 0o700)
    throw new Error('Choose a private 0700 data directory that is not a link.');
  if ((await readdir(dataDir)).length > 0)
    throw new Error('Choose an empty data directory; earlier evidence is never reused.');
  for (const port of [headsetPort, connectorPort])
    if (!(await portFree(port))) throw new Error(`Port ${port} is in use; nothing was started.`);

  const files = join(dataDir, 'files');
  await mkdir(files, { mode: 0o700 });
  const headsetUrl = `http://127.0.0.1:${headsetPort}`;
  const env = environment(dataDir, headsetPort, connectorPort);
  const checks = [];
  const check = (name) => {
    checks.push(name);
    log(`ok - ${name}`);
  };
  const headset = async (method, path, body) => {
    const response = await fetch(`${headsetUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    if (!response.ok)
      throw new Error(`${method} ${path} gave ${response.status} ${json.error?.code}`);
    return json;
  };
  let step = 'service start';
  const cli = async (...args) => {
    const { stdout } = await run(
      process.execPath,
      ['src/cli/activity.ts', ...args, '--data-dir', dataDir, '--port', String(connectorPort)],
      { cwd: SERVICE, env },
    );
    return stdout.trim();
  };
  const journalCounts = () => {
    const db = new DatabaseSync(join(dataDir, 'journal.sqlite'), { readOnly: true });
    try {
      return {
        events: db.prepare('SELECT count(*) AS n FROM events').get().n,
        activityEvents: db
          .prepare("SELECT count(*) AS n FROM events WHERE type LIKE 'activity.%'")
          .get().n,
      };
    } finally {
      db.close();
    }
  };
  const snapshot = async (ids) => ({
    list: await headset('GET', '/v1/activities'),
    views: Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await headset('GET', `/v1/activities/${id}`)])),
    ),
  });
}
