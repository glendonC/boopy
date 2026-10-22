import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkHandoffBundle, exportHandoffBundle } from './export-handoff-bundle.ts';

async function fixture(
  work: (
    input: {
      packageId: string;
      requestId: string;
      dataDir: string;
      port: number;
      outputDirectory: string;
      task: string;
    },
    change: (mode: string) => void,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-bundle-test-'));
  await writeFile(join(directory, 'connector-token'), 'synthetic-token', { mode: 0o600 });
  const packet =
    'Fictional context only. Model proposal: desert. Person said: I walked. Unknown: weather.\n';
  const packetSha256 = createHash('sha256').update(packet).digest('hex');
  let mode = 'unchanged';
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic-token');
    assert.ok(req.url?.includes('request=selected-request'));
    if (mode === 'refuse') {
      res.writeHead(404).end();
      return;
    }
    if (req.url?.includes('/packet')) {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(packet);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        state: 'prepared-local',
        packageId: 'ctx_selected',
        requestId: 'selected-request',
        sourceState: mode === 'changed' ? 'changed' : 'unchanged',
        receipt: {
          receiptId: 'handoff_selected',
          packageId: 'ctx_selected',
          requestId: 'selected-request',
          packetSha256: mode === 'wrong-hash' ? '0'.repeat(64) : packetSha256,
          delivery: 'not-sent',
          historicalSnapshot: true,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await work(
      {
        packageId: 'ctx_selected',
        requestId: 'selected-request',
        dataDir: directory,
        port: (server.address() as AddressInfo).port,
        outputDirectory: join(directory, 'bundle'),
        task: 'Literal task: $HOME `no execution` 한국어.\nKeep this line.',
      },
      (value) => {
        mode = value;
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('exact private three-file bundle preserves literal task, packet and IDs without delivery claim', async () =>
  fixture(async (input) => {
    const result = await exportHandoffBundle(input);
    assert.deepEqual((await readdir(result.directory)).sort(), [
      'continue.txt',
      'manifest.json',
      'selected-context.txt',
    ]);
    for (const name of result.files)
      assert.equal((await stat(join(result.directory, name))).mode & 0o777, 0o600);
    assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
    assert.ok(
      (await readFile(join(result.directory, 'continue.txt'), 'utf8')).includes(input.task),
    );
    const metadata = JSON.stringify(result);
    assert.ok(!metadata.includes(input.task));
    assert.ok(!metadata.includes('synthetic-token'));
    assert.equal(result.externalDelivery, 'not-attempted');
    const check = await checkHandoffBundle({
      directory: result.directory,
      dataDir: input.dataDir,
      port: input.port,
    });
    assert.equal(check.sourceState, 'unchanged');
    assert.equal(check.readyForReview, true);
    assert.equal(check.externalDelivery, 'unverified');
    await assert.rejects(exportHandoffBundle(input));
  }));

test('changed source and unavailable service cannot relabel an old bundle current', async () =>
  fixture(async (input, change) => {
    await exportHandoffBundle(input);
    change('changed');
    assert.equal(
      (await checkHandoffBundle({ ...input, directory: input.outputDirectory })).readyForReview,
      false,
    );
    change('refuse');
    const check = await checkHandoffBundle({ ...input, directory: input.outputDirectory });
    assert.equal(check.sourceState, 'unverified');
    assert.equal(check.readyForReview, false);
  }));

test('changed receipt refuses completion; changed packet/task, extra files and symlinks fail integrity', async () => {
  await fixture(async (input, change) => {
    change('wrong-hash');
    await assert.rejects(exportHandoffBundle(input));
    assert.deepEqual(await readdir(input.outputDirectory), ['selected-context.txt']);
  });
  for (const target of ['selected-context.txt', 'continue.txt', 'extra.txt', 'symlink'])
    await fixture(async (input) => {
      await exportHandoffBundle(input);
      if (target === 'symlink') {
        await rm(join(input.outputDirectory, 'continue.txt'));
        await symlink(
          join(input.outputDirectory, 'selected-context.txt'),
          join(input.outputDirectory, 'continue.txt'),
        );
      } else
        await writeFile(join(input.outputDirectory, target), 'synthetic-tamper', { mode: 0o600 });
      await assert.rejects(checkHandoffBundle({ ...input, directory: input.outputDirectory }));
    });
});

test('unbounded tasks, implicit request selections and public directories are refused', async () =>
  fixture(async (input) => {
    for (const task of ['', 'x'.repeat(4001), 'synthetic\0task'])
      await assert.rejects(exportHandoffBundle({ ...input, task }));
    await assert.rejects(exportHandoffBundle({ ...input, requestId: '' }));
    await chmod(input.dataDir, 0o755);
    await assert.rejects(exportHandoffBundle(input));
  }));
