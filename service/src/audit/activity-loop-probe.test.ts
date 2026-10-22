/**
 * Adversarial checks of the activity loop probe (BACKEND U8). It starts the real service, so every
 * case here uses kernel-chosen ports and temporary folders; even a probe that ignored a refusal
 * would only reach a temporary folder or this checkout, never 47900, 47901 or a real journal.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROBE = join(SERVICE, 'probes', 'activity-loop.mjs');
type Loop = (options: {
  dataDir: string;
  headsetPort: number;
  connectorPort: number;
  log?: (line: string) => void;
}) => Promise<{ result: string; requestId: string; files: string[] }>;
const { runActivityLoop } = (await import(pathToFileURL(PROBE).href)) as { runActivityLoop: Loop };

/** Ports the kernel just handed out, never 47900, 47901, 47910 or 47911. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.ok(address.port < 47900 || address.port > 47911);
  return address.port;
}

async function freePorts(): Promise<[number, number]> {
  const headset = await freePort();
  let connector = await freePort();
  while (connector === headset) connector = await freePort();
  return [headset, connector];
}

async function privateDir(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  await chmod(directory, 0o700);
  return directory;
}

async function answering(port: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`, {
      signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/** Whether anything listens on the port, as lsof sees it; no request is made. */
function listening(port: number): boolean {
  try {
    return (
      execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
      }).trim() !== ''
    );
  } catch {
    return false;
  }
}

/** Stops a service this test started and lost: only a process running src/main.ts on our port. */
function stopListeners(port: number): number {
  let pids: number[] = [];
  try {
    pids = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return 0;
  }
  let stopped = 0;
  for (const pid of pids) {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    });
    if (!command.includes('src/main.ts')) continue;
    process.kill(pid, 'SIGTERM');
    stopped += 1;
  }
  return stopped;
}

const quiet = () => {};

test('audit U8 guard: no key, provider, port, data folder or Node option leaks from the caller', async () => {
  const dataDir = await privateDir('boopy-audit-loop-env-');
  const elsewhere = await privateDir('boopy-audit-loop-elsewhere-');
  const [headsetPort, connectorPort] = await freePorts();
  const hostile: Record<string, string> = {
    MODEL_API_KEY: 'synthetic-audit-key-3391',
    BOOPY_INTERPRETER: 'muse-spark',
    BOOPY_OLLAMA_URL: 'http://192.0.2.1:9',
    BOOPY_CONNECTOR_URL: 'https://fictional.example',
    BOOPY_DATA_DIR: elsewhere,
    BOOPY_PORT: '1',
    BOOPY_CONNECTOR_PORT: '2',
    BOOPY_LOG: '1',
    BOOPY_SEGMENTER: 'sam',
    BOOPY_ZETARIS_REFERENCE_CREDENTIAL_FILE: '/nonexistent/audit-credential',
    NODE_OPTIONS: '--require=/nonexistent/audit-preload.js',
  };
  const saved = Object.fromEntries(Object.keys(hostile).map((key) => [key, process.env[key]]));
  Object.assign(process.env, hostile);
  const lines: string[] = [];
  try {
    const summary = await runActivityLoop({
      dataDir,
      headsetPort,
      connectorPort,
      log: (line) => lines.push(line),
    });
    assert.equal(summary.result, 'pass');
    assert.deepEqual(await readdir(elsewhere), []);
    const token = (await readFile(join(dataDir, 'connector-token'), 'utf8')).trim();
    const request = JSON.parse(
      await readFile(join(dataDir, 'files', summary.files[0] ?? ''), 'utf8'),
    );
    const printed = `${lines.join('\n')}\n${JSON.stringify(summary)}`;
    for (const secret of [
      dataDir,
      token,
      'synthetic-audit-key-3391',
      String(request.context.packet).slice(0, 60),
      SERVICE,
    ])
      assert.equal(printed.includes(secret), false, 'printed a path, token, key or packet text');
    assert.equal(await answering(headsetPort), false);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    stopListeners(headsetPort);
    await rm(dataDir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test('audit U8: a relative data path is refused before anything starts', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'boopy-audit-loop-relative-'));
  const name = `.audit-relative-${randomUUID()}`;
  await mkdir(join(parent, name), { mode: 0o700 });
  const [headsetPort, connectorPort] = await freePorts();
  const cwd = process.cwd();
  try {
    process.chdir(parent);
    await assert.rejects(
      runActivityLoop({ dataDir: name, headsetPort, connectorPort, log: quiet }),
      /absolute|relative/i,
    );
  } finally {
    process.chdir(cwd);
    stopListeners(headsetPort);
    // The service resolves a relative BOOPY_DATA_DIR against service/, not the caller's folder.
    const leaked = existsSync(join(SERVICE, name));
    await rm(join(SERVICE, name), { recursive: true, force: true });
    const left = await readdir(join(parent, name));
    await rm(parent, { recursive: true, force: true });
    assert.equal(leaked, false, 'the service wrote a journal outside the checked folder');
    assert.deepEqual(left, []);
  }
});

test('audit U8: a symbolic link to a data folder is refused, also behind a trailing slash', async () => {
  const root = await privateDir('boopy-audit-loop-link-');
  const target = join(root, 'target');
  await mkdir(target, { mode: 0o700 });
  const link = join(root, 'link');
  await symlink(target, link);
  const [headsetPort, connectorPort] = await freePorts();
  try {
    for (const dataDir of [link, `${link}/`, `${link}/.`, `${link}//`])
      await assert.rejects(
        runActivityLoop({ dataDir, headsetPort, connectorPort, log: quiet }),
        Error,
        dataDir,
      );
    assert.deepEqual(await readdir(target), []);
  } finally {
    stopListeners(headsetPort);
    await rm(root, { recursive: true, force: true });
  }
});

test("audit U8: the service's own default data folder ~/.boopy is refused even when empty", async () => {
  const home = await privateDir('boopy-audit-loop-home-');
  const boopy = join(home, '.boopy');
  await mkdir(boopy, { mode: 0o700 });
  const [headsetPort, connectorPort] = await freePorts();
  const saved = process.env.HOME;
  // config.ts defaults BOOPY_DATA_DIR to join(homedir(), '.boopy'); homedir() follows HOME.
  process.env.HOME = home;
  try {
    for (const dataDir of [boopy, `${boopy}/`, `${home}/./.boopy`, `${home}//.boopy`])
      await assert.rejects(
        runActivityLoop({ dataDir, headsetPort, connectorPort, log: quiet }),
        Error,
        dataDir,
      );
    assert.deepEqual(await readdir(boopy), []);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    stopListeners(headsetPort);
    await rm(home, { recursive: true, force: true });
  }
});

test('audit U8: a failing step never reports a path, the token or the Node binary', async () => {
  const dataDir = await privateDir('boopy-audit-loop-failure-');
  const [headsetPort, connectorPort] = await freePorts();
  const files = join(dataDir, 'files');
  try {
    const failure = await runActivityLoop({
      dataDir,
      headsetPort,
      connectorPort,
      // Once the handoff is prepared, make the output folder unwritable so the request step fails.
      log: (line) => {
        if (line.includes('local handoff prepared')) chmodSync(files, 0o500);
      },
    }).then(
      () => null,
      (error: Error) => error.message,
    );
    assert.ok(failure !== null, 'the run should fail at the request step');
    const token = (await readFile(join(dataDir, 'connector-token'), 'utf8')).trim();
    for (const secret of [dataDir, files, token, process.execPath, SERVICE])
      assert.equal(failure.includes(secret), false, 'the failure message carries a path or token');
    assert.equal(await answering(headsetPort), false, 'the child kept running after a failure');
  } finally {
    if (existsSync(files)) chmodSync(files, 0o700);
    stopListeners(headsetPort);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('audit U8: SIGTERM or SIGINT to the probe alone also stops its service', {
  // Two services start and stop here. A service stopped while the probe's request is in flight
  // waits out its 72 s keep-alive timeout before it exits, so a loaded machine needs minutes.
  timeout: 300_000,
}, async () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const root = await privateDir('boopy-audit-loop-signal-');
    const [headsetPort, connectorPort] = await freePorts();
    assert.ok(headsetPort && connectorPort);
    const probe = spawn(
      process.execPath,
      [
        PROBE,
        '--headset-port',
        String(headsetPort),
        '--connector-port',
        String(connectorPort),
        '--data-root',
        root,
      ],
      { cwd: SERVICE, stdio: 'ignore' },
    );
    let ended = false;
    const exited = new Promise<void>((resolve) =>
      probe.once('exit', () => {
        ended = true;
        resolve();
      }),
    );
    try {
      // The probe's service is up once it listens on its port. lsof sees that without a request,
      // so nothing has to answer within a fixed time; only the test's own deadline bounds this.
      while (!listening(headsetPort)) {
        assert.equal(ended, false, 'the probe ended before its service started');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      probe.kill(signal);
      await exited;
      // The probe waits for its service to exit before it exits itself, so a service still
      // listening on the port now was left running; lsof sees it however slow it is to answer.
      assert.equal(
        stopListeners(headsetPort),
        0,
        `${signal} to the probe left its service running`,
      );
    } finally {
      if (probe.exitCode === null && probe.signalCode === null) probe.kill('SIGKILL');
      stopListeners(headsetPort);
      await rm(root, { recursive: true, force: true });
    }
  }
});
