import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportPrepared } from './export-prepared.ts';

test('prepared export rejects oversized bodies and redirects without writing private response bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-prepared-bounds-'));
  await writeFile(join(directory, 'connector-token'), 'synthetic-bounds-token', { mode: 0o600 });
  let mode = 'large';
  let received = '';
  const server = createServer((request, response) => {
    received = request.headers.authorization ?? '';
    if (mode === 'redirect') {
      response.writeHead(302, { location: 'https://example.invalid/private' });
      response.end();
    } else {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(Buffer.alloc(8 * 1024 * 1024 + 1, 120));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    for (const name of ['large', 'redirect']) {
      mode = name;
      const output = join(directory, `${name}.txt`);
      await assert.rejects(
        exportPrepared({ packageId: 'ctx_synthetic', dataDir: directory, output, port }),
      );
      assert.equal(received, 'Bearer synthetic-bounds-token');
      assert.equal(await readFile(output, 'utf8'), '');
      assert.equal((await stat(output)).mode & 0o777, 0o600);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
