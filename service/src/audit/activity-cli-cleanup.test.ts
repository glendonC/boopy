/**
 * Adversarial checks of the CLI cleanup set (BACKEND U15, U15b, U15c): a failed or stopped command
 * removes only the file it created, never a file another process put at the same name meanwhile,
 * and says so by name only. A fake loopback connector holds each request so the timing is ours.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportSubmission } from '../cli/activity.ts';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBMISSION = 'sub_auditcleanup1';
const NAME = `boopy-activity-submission-${SUBMISSION}.json`;

/** A connector that holds every request until released, then refuses it as unknown. */
async function heldConnector() {
  const held: ServerResponse[] = [];
  let arrived: () => void = () => {};
  const firstRequest = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    held.push(outgoing);
    arrived();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    firstRequest,
    refuse() {
      for (const outgoing of held.splice(0)) {
        outgoing.writeHead(404, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({ error: { code: 'submission_unknown', message: 'No such submission.' } }),
        );
      }
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function folders() {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-cleanup-'));
  const dataDir = join(directory, 'data');
  const out = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(dataDir, 'connector-token'), 'synthetic-audit-cleanup-token', {
    mode: 0o600,
  });
  return { directory, dataDir, out, path: join(out, NAME) };
}

/** Another process removes the claimed file and writes its own file under the same name. */
async function replaceWithAnotherProcessFile(path: string) {
  await rm(path);
  await writeFile(path, 'written by another process', { mode: 0o600 });
}

test('audit U15: a failed export never removes a file another process put at its name', async () => {
  const { directory, dataDir, out, path } = await folders();
  const connector = await heldConnector();
  try {
    const running = exportSubmission({
      dataDir,
      port: connector.port,
      submissionId: SUBMISSION,
      outDir: out,
    });
    await connector.firstRequest;
    assert.equal((await lstat(path)).size, 0, 'the export claims its file before asking');
    await replaceWithAnotherProcessFile(path);
    connector.refuse();
    await assert.rejects(running, /404 submission_unknown/);
    assert.equal(
      await readFile(path, 'utf8').catch(() => 'removed'),
      'written by another process',
      'the failed export removed a file it did not create',
    );
  } finally {
    await connector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** Runs `pnpm activity export` as a separate process against the held connector. */
function exportProcess(dataDir: string, out: string, port: number) {
  const child = spawn(
    process.execPath,
    [
      'src/cli/activity.ts',
      'export',
      '--submission',
      SUBMISSION,
      '--out-dir',
      out,
      '--data-dir',
      dataDir,
      '--port',
      String(port),
    ],
    { cwd: SERVICE, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  return { child, exited, stderr: () => stderr };
}

test('audit U15 guard: a stopped export removes its own file and names it without a path', async () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const { directory, dataDir, out, path } = await folders();
    const connector = await heldConnector();
    const run = exportProcess(dataDir, out, connector.port);
    try {
      await connector.firstRequest;
      assert.equal((await lstat(path)).size, 0);
      run.child.kill(signal);
      assert.equal(await run.exited, signal === 'SIGINT' ? 130 : 143);
      assert.equal(
        await lstat(path).then(
          () => 'kept',
          () => 'removed',
        ),
        'removed',
        signal,
      );
      assert.match(
        run.stderr(),
        new RegExp(`Stopped before ${NAME} was finished, so it was removed`),
      );
      for (const secret of [directory, dataDir, out, 'synthetic-audit-cleanup-token'])
        assert.equal(
          run.stderr().includes(secret),
          false,
          'the stop message carries a path or token',
        );
    } finally {
      if (run.child.exitCode === null) run.child.kill('SIGKILL');
      await connector.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('audit U15: a stopped export never removes a file another process put at its name', async () => {
  const { directory, dataDir, out, path } = await folders();
  const connector = await heldConnector();
  const run = exportProcess(dataDir, out, connector.port);
  try {
    await connector.firstRequest;
    assert.equal((await lstat(path)).size, 0);
    await replaceWithAnotherProcessFile(path);
    run.child.kill('SIGINT');
    await run.exited;
    assert.equal(
      await readFile(path, 'utf8').catch(() => 'removed'),
      'written by another process',
      'the stopped export removed a file it did not create',
    );
  } finally {
    if (run.child.exitCode === null) run.child.kill('SIGKILL');
    await connector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
