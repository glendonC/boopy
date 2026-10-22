import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { type AddressInfo, createConnection } from 'node:net';
import { it } from 'node:test';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { startMuseDemoGate } from './muse-demo-gate.ts';

function get(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        headers: { host: 'synthetic.example', ...options.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

it('starts closed and forwards only exact synthetic REST routes with bearer protection', async () => {
  const { boopy, journal } = testBoopy();
  const app = connectorApp(boopy, {
    token: 'synthetic-secret',
    baseUrl: 'https://synthetic.example',
    logger: false,
  });
  const gate = await startMuseDemoGate();
  try {
    const view = await boopy.start(startRequest('Synthetic gate fixture.'));
    const id = boopy.commit(view.id).committed?.packageId;
    assert.ok(id);
    await app.listen({ host: '127.0.0.1', port: 0 });
    assert.equal((await get(`${gate.localUrl}/health`)).status, 503);
    gate.activate({
      origin: 'https://synthetic.example',
      upstreamUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
      packageId: id,
    });
    assert.equal((await get(`${gate.localUrl}/health`)).status, 200);
    assert.equal((await get(`${gate.localUrl}/openapi.json`)).status, 200);
    assert.equal((await get(`${gate.localUrl}/v1/context/${id}`)).status, 401);
    assert.equal(
      (
        await get(`${gate.localUrl}/v1/context/${id}`, {
          headers: { authorization: 'Bearer wrong-synthetic' },
        })
      ).status,
      401,
    );
    const listed = await get(`${gate.localUrl}/v1/context?query=Synthetic&limit=1`, {
      headers: { authorization: 'Bearer synthetic-secret' },
    });
    assert.equal(listed.status, 200);
    assert.equal(JSON.parse(listed.body).results.length, 1);
    const found = await get(`${gate.localUrl}/v1/context/${id}`, {
      headers: { authorization: 'Bearer synthetic-secret' },
    });
    assert.equal(found.status, 200);
    assert.equal(JSON.parse(found.body).id, id);
    assert.equal(boopy.disclosures.length, 2);
    assert.deepEqual(gate.diagnostics().forwardedByRoute, {
      health: 1,
      schema: 1,
      list: 1,
      package: 3,
    });
    for (const path of [
      '/mcp',
      '/v1/recall',
      '/v1/context/other',
      '/v1/sessions',
      '/%76%31/context',
      '//v1/context',
      '/v1/context?token=synthetic-secret',
    ])
      assert.ok(
        [400, 404].includes(
          (
            await get(`${gate.localUrl}${path}`, {
              headers: { authorization: 'Bearer synthetic-secret' },
            })
          ).status,
        ),
      );
    assert.equal((await get(`${gate.localUrl}/v1/context`, { method: 'POST' })).status, 405);
    assert.equal(
      (
        await get(`${gate.localUrl}/health`, {
          headers: { host: 'evil.example', 'x-forwarded-host': 'synthetic.example' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await get(`${gate.localUrl}/health`, { headers: { origin: 'https://evil.example' } }))
        .status,
      403,
    );
    assert.equal(
      (await get(`${gate.localUrl}/health`, { headers: { 'content-length': '1' }, body: 'x' }))
        .status,
      413,
    );
    assert.equal(
      (await get(`${gate.localUrl}/health`, { headers: { 'x-big': 'x'.repeat(9000) } })).status,
      400,
    );
    assert.equal(boopy.disclosures.length, 2);
    assert.throws(() =>
      gate.activate({
        origin: 'https://synthetic.example',
        upstreamUrl: 'http://127.0.0.1:1',
        packageId: id,
      }),
    );
  } finally {
    await gate.close();
    await app.close();
    journal.close();
  }
  await assert.rejects(get(`${gate.localUrl}/health`));
});

it('limits global requests, concurrent work and upstream lifetime', async () => {
  const upstream = createServer((_req, _res) => {});
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gate = await startMuseDemoGate({ upstreamTimeoutMs: 40 });
  try {
    gate.activate({
      origin: 'https://synthetic.example',
      upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      packageId: 'synthetic',
    });
    const pending = [get(`${gate.localUrl}/health`), get(`${gate.localUrl}/health`)];
    assert.equal((await get(`${gate.localUrl}/health`)).status, 429);
    assert.deepEqual(
      (await Promise.all(pending)).map((response) => response.status),
      [502, 502],
    );
    assert.equal(gate.diagnostics().upstreamTimeouts, 2);
    assert.equal(gate.diagnostics().upstreamErrors, 2);
    assert.equal(gate.diagnostics().upstreamResponses, 0);
    for (let count = 3; count < 30; count++)
      assert.equal((await get(`${gate.localUrl}/mcp`)).status, 404);
    assert.equal((await get(`${gate.localUrl}/health`)).status, 429);
  } finally {
    await gate.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it('validates origin/loopback destinations without echoing secrets and expires automatically', async () => {
  const gate = await startMuseDemoGate({ ttlMs: 20 });
  for (const origin of [
    'http://synthetic.example',
    'https://user:secret@synthetic.example',
    'https://synthetic.example?secret=token',
  ])
    assert.throws(
      () => gate.activate({ origin, upstreamUrl: 'http://127.0.0.1:1234', packageId: 'synthetic' }),
      { message: 'Invalid demo gate destination.' },
    );
  assert.throws(() =>
    gate.activate({
      origin: 'https://synthetic.example',
      upstreamUrl: 'http://example.com:1234',
      packageId: 'synthetic',
    }),
  );
  await gate.closed;
  await assert.rejects(get(`${gate.localUrl}/health`));
});

it('bounds incomplete-header sockets and destroys them on idle timeout or teardown', async () => {
  const gate = await startMuseDemoGate({ upstreamTimeoutMs: 50 });
  const url = new URL(gate.localUrl);
  const connect = () => createConnection({ host: '127.0.0.1', port: Number(url.port) });
  try {
    const socket = connect();
    const closed = new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('close', () => resolve());
    });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write('GET /health HTTP/1.1\r\nHost: synthetic.example\r\nX-Incomplete: ');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Incomplete headers remained open')), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      socket.destroy();
    }
    assert.equal(socket.destroyed, true);
    const teardownSocket = connect();
    const teardownClosed = new Promise<void>((resolve) =>
      teardownSocket.once('close', () => resolve()),
    );
    teardownSocket.on('error', () => {});
    await new Promise<void>((resolve) => teardownSocket.once('connect', resolve));
    teardownSocket.write('GET /health HTTP/1.1\r\n');
    await gate.close();
    await teardownClosed;
    assert.equal(teardownSocket.destroyed, true);
  } finally {
    await gate.close();
  }
});

it('reports only detached aggregate arrival and outcome counters', async () => {
  const upstream = createServer((_req, res) => res.writeHead(401).end());
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gate = await startMuseDemoGate();
  try {
    assert.equal((await get(`${gate.localUrl}/health`)).status, 503);
    gate.activate({
      origin: 'https://synthetic.example',
      upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      packageId: 'synthetic-private-id',
    });
    assert.equal((await get(`${gate.localUrl}/not-allowed?private=value`)).status, 404);
    assert.equal(
      (
        await get(`${gate.localUrl}/health`, {
          headers: { authorization: 'Bearer synthetic-private-token' },
        })
      ).status,
      401,
    );
    const snapshot = gate.diagnostics();
    assert.deepEqual(snapshot, {
      received: 3,
      forwarded: 1,
      refused: 2,
      upstreamResponses: 1,
      upstreamErrors: 0,
      upstreamTimeouts: 0,
      malformedRequests: 0,
      forwardedByRoute: { health: 1, schema: 0, list: 0, package: 0 },
    });
    snapshot.received = 999;
    snapshot.forwardedByRoute.health = 999;
    assert.equal(gate.diagnostics().forwardedByRoute.health, 1);
    assert.equal(gate.diagnostics().received, 3);
    assert.doesNotMatch(
      JSON.stringify(gate.diagnostics()),
      /private|Bearer|authorization|\/health/,
    );
    await gate.close();
    assert.equal(gate.diagnostics().received, 3);
  } finally {
    await gate.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
