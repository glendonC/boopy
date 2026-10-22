import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { connectorApp } from './http/connector.ts';
import { exportContext } from './manual-handoff.ts';
import { startRequest, testBoopy } from './testing.ts';

const token = 'synthetic-export-test-token';
function required<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}
async function directory() {
  const dataDir = await mkdtemp(join(tmpdir(), 'boopy-export-test-'));
  await writeFile(join(dataDir, 'connector-token'), token, { mode: 0o600 });
  return dataDir;
}
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('explicit manual context handoff', () => {
  it('exports exactly one delivered package text with correction overlay and disclosure', async () => {
    const dataDir = await directory();
    const { boopy, journal } = testBoopy();
    const first = await boopy.start(startRequest('Synthetic first account'));
    const old = required(boopy.commit(first.id).committed).packageId;
    const second = await boopy.start(startRequest('Synthetic corrected account'));
    const next = required(boopy.commit(second.id).committed).packageId;
    const predecessor = required(required(boopy.package(old)).items[0]);
    const successor = required(required(boopy.package(next)).items[0]);
    boopy.supersede({
      predecessor: { packageId: old, itemId: predecessor.id },
      successor: { packageId: next, itemId: successor.id },
    });
    const app = connectorApp(boopy, {
      token,
      baseUrl: 'http://127.0.0.1',
      logger: false,
      memory: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const output = join(dataDir, 'handoff.txt');
      const before = boopy.disclosures.length;
      const result = await exportContext({
        packageId: old,
        dataDir,
        output,
        port: (app.server.address() as AddressInfo).port,
      });
      const text = await readFile(output, 'utf8');
      const notice = `- Superseded item ${predecessor.id} (${predecessor.label}). Do not use this old claim for a current answer. Fetch successor package ${next}, item ${successor.id}. Linking does not confirm the successor.`;
      assert.equal(
        text,
        `${required(boopy.package(old)).text}\n\nLater human corrections (read-time overlay; the saved snapshot above is historical):\n${notice}`,
      );
      assert.deepEqual(result, { packageId: old, path: output, bytes: Buffer.byteLength(text) });
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      assert.equal(boopy.disclosures.length, before + 1);
      assert.equal(required(boopy.disclosures.at(-1)).packageId, old);
      assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(JSON.stringify(result).includes(predecessor.statement), false);
      await assert.rejects(
        exportContext({
          packageId: old,
          dataDir,
          output,
          port: (app.server.address() as AddressInfo).port,
        }),
      );
      assert.equal(await readFile(output, 'utf8'), text);
    } finally {
      await app.close();
      journal.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects incorrect authentication without writing or disclosing', async () => {
    const dataDir = await directory();
    const { boopy, journal } = testBoopy();
    const view = await boopy.start(startRequest('Synthetic account'));
    const packageId = required(boopy.commit(view.id).committed).packageId;
    const app = connectorApp(boopy, {
      token: 'different-synthetic-token',
      baseUrl: 'http://127.0.0.1',
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const output = join(dataDir, 'handoff.txt');
      await assert.rejects(
        exportContext({
          packageId,
          dataDir,
          output,
          port: (app.server.address() as AddressInfo).port,
        }),
      );
      await assert.rejects(stat(output));
      assert.equal(boopy.disclosures.length, 0);
    } finally {
      await app.close();
      journal.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a wrong package identity, malformed package, oversize body and redirect without following it', async () => {
    const dataDir = await directory();
    const { boopy, journal } = testBoopy();
    const view = await boopy.start(startRequest('Synthetic account'));
    const packageId = required(boopy.commit(view.id).committed).packageId;
    let mode = 'identity';
    let redirected = 0;
    const server = createServer((request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (request.url === '/redirect-target') {
        redirected++;
        response.end('should never fetch');
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (mode === 'redirect') {
        response.writeHead(302, { location: '/redirect-target' });
        response.end();
      } else if (mode === 'oversize') response.end('x'.repeat(2 * 1024 * 1024 + 1));
      else if (mode === 'malformed')
        response.end(JSON.stringify({ id: packageId, text: 'invalid package' }));
      else response.end(JSON.stringify({ ...boopy.package(packageId), id: 'different-package' }));
    });
    const port = await listen(server);
    try {
      for (mode of ['identity', 'malformed', 'oversize', 'redirect']) {
        const output = join(dataDir, `${mode}.txt`);
        await assert.rejects(exportContext({ packageId, dataDir, output, port }));
        await assert.rejects(stat(output));
      }
      assert.equal(redirected, 0);
    } finally {
      await close(server);
      journal.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
