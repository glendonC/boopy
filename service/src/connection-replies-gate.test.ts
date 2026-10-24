import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Two free loopback ports, released before the service takes them. */
async function ports(): Promise<[number, number]> {
  const servers = [createServer(), createServer()];
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
  );
  const found = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  return [found[0] ?? 0, found[1] ?? 0];
}

/** Starts the service on a synthetic data folder and asks its connector to name a connection. */
async function connectStatus(switchOn: boolean): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-connection-gate-'));
  const [port, connectorPort] = await ports();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./main.ts', import.meta.url))], {
    env: {
      PATH: '/usr/bin:/bin',
      BOOPY_DATA_DIR: directory,
      BOOPY_PORT: String(port),
      BOOPY_CONNECTOR_PORT: String(connectorPort),
      BOOPY_INTERPRETER: 'fixture',
      BOOPY_LOG: '0',
      ...(switchOn ? { BOOPY_CONNECTION_REPLIES: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    for (let waited = 0; !output.includes('headset API'); waited += 50) {
      if (waited > 10_000 || child.exitCode !== null) throw new Error('The service did not start.');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const token = (await readFile(join(directory, 'connector-token'), 'utf8')).trim();
    const response = await fetch(`http://127.0.0.1:${connectorPort}/v1/local-tasks/connections`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt_gate', connectionId: 'con_gate', label: 'Gate' }),
    });
    await response.body?.cancel();
    return response.status;
  } finally {
    child.kill('SIGTERM');
    // main.ts ignores a second signal, so a stop that hangs is killed rather than outliving the test.
    let timer: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
    clearTimeout(timer);
    if (!stopped) {
      child.kill('SIGKILL');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('the connection reply routes stay off until BOOPY_CONNECTION_REPLIES is 1', {
  timeout: 60_000,
}, async () => {
  assert.equal(await connectStatus(false), 404);
  assert.equal(await connectStatus(true), 200);
});
