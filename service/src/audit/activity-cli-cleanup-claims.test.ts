/**
 * Adversarial checks of U15d: cleanup leaves a link another process put at the name (and its
 * target) alone, and a stopped command claims a removal only when one happened.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportSubmission } from '../cli/activity.ts';

const SERVICE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBMISSION = 'sub_auditclaims1';
const NAME = `boopy-activity-submission-${SUBMISSION}.json`;

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
  const directory = await mkdtemp(join(tmpdir(), 'boopy-audit-claims-'));
  const dataDir = join(directory, 'data');
  const out = join(directory, 'out');
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(dataDir, 'connector-token'), 'synthetic-audit-claims-token', {
    mode: 0o600,
  });
  return { directory, dataDir, out, path: join(out, NAME) };
}

test('audit U15d: a link another process put at the name, and its target, are left alone', async () => {
  const { directory, dataDir, out, path } = await folders();
  const target = join(directory, 'outside.json');
  await writeFile(target, 'synthetic outside file');
  const connector = await heldConnector();
  try {
    const running = exportSubmission({
      dataDir,
      port: connector.port,
      submissionId: SUBMISSION,
      outDir: out,
    });
    await connector.firstRequest;
    await rm(path);
    await symlink(target, path);
    connector.refuse();
    await assert.rejects(running, /404 submission_unknown/);
    assert.ok((await lstat(path)).isSymbolicLink(), 'the link at the name was removed');
    assert.equal(await readlink(path), target);
    assert.equal(await readFile(target, 'utf8'), 'synthetic outside file');
  } finally {
    await connector.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit U15d: a stopped command whose file was replaced claims no removal', async () => {
  const { directory, dataDir, out, path } = await folders();
  const connector = await heldConnector();
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
      String(connector.port),
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
  try {
    await connector.firstRequest;
    await rm(path);
    await writeFile(path, 'written by another process', { mode: 0o600 });
    child.kill('SIGINT');
    assert.equal(await exited, 130);
    assert.equal(await readFile(path, 'utf8'), 'written by another process');
    assert.doesNotMatch(stderr, /removed/, 'the stop message claims a removal that did not happen');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await connector.close();
    await rm(directory, { recursive: true, force: true });
  }
});
