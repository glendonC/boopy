import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';

describe('connector boundaries for owner-opened HTTPS forwarding', () => {
  const token = 'synthetic-connector-security-token';
  const baseUrl = 'https://boopy.example';
  const { boopy } = testBoopy();
  const app = connectorApp(boopy, { token, baseUrl, logger: false });
  const headers = { host: 'boopy.example', authorization: `Bearer ${token}` };
  const packageIds: string[] = [];
  let uncommittedId = '';
  let localUrl = '';

  before(async () => {
    for (const said of ['Help me practice Korean.', 'Help me describe this trip.']) {
      const view = await boopy.start(startRequest(said));
      packageIds.push(boopy.commit(view.id).committed?.packageId ?? '');
    }
    uncommittedId = (await boopy.start(startRequest('What is this?'))).id;
    await app.listen({ host: '127.0.0.1', port: 0 });
    localUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(() => app.close());

  it('fails closed for blank tokens and rejects secret-bearing published URLs', () => {
    for (const blank of ['', ' \n\t '])
      assert.throws(
        () => connectorApp(boopy, { token: blank, baseUrl, logger: false }),
        /non-empty/,
      );
    const urls = [
      'https://synthetic-user:synthetic-password@boopy.example',
      'https://boopy.example?token=synthetic-secret',
      'https://boopy.example#synthetic-secret',
    ];
    for (const unsafe of urls) {
      assert.throws(
        () => connectorApp(boopy, { token, baseUrl: unsafe, logger: false }),
        (error: unknown) =>
          error instanceof Error &&
          /credentials, query or fragment/.test(error.message) &&
          !error.message.includes('synthetic-'),
      );
    }
    for (const invalid of ['synthetic-secret-invalid-url', 'ftp://boopy.example']) {
      assert.throws(
        () => connectorApp(boopy, { token, baseUrl: invalid, logger: false }),
        (error: unknown) =>
          error instanceof Error &&
          /valid HTTP or HTTPS URL/.test(error.message) &&
          !error.message.includes('synthetic-secret'),
      );
    }
  });

  it('denies every data route and MCP method without the exact bearer token, without disclosures', async () => {
    const before = boopy.disclosures.length;
    for (const authorization of [undefined, 'Bearer wrong-token', 'Basic wrong-token']) {
      for (const request of [
        { method: 'GET' as const, url: '/v1/context' },
        { method: 'GET' as const, url: `/v1/context/${packageIds[0]}` },
        { method: 'GET' as const, url: '/mcp' },
        { method: 'POST' as const, url: '/mcp', payload: {} },
        { method: 'DELETE' as const, url: '/mcp' },
      ]) {
        const response = await app.inject({
          ...request,
          headers: { host: 'boopy.example', ...(authorization && { authorization }) },
        });
        assert.equal(response.statusCode, 401);
        assert.equal(response.headers['www-authenticate'], 'Bearer');
        assert.ok(!response.body.includes(packageIds[0] ?? 'unmatched-id'));
      }
    }
    assert.equal(boopy.disclosures.length, before);
    for (const url of [
      '/%76%31/context',
      '/v1%2fcontext',
      '/%6dcp',
      '/mcp/',
      '//v1/context',
      '/MCP',
      `/v1/context/${packageIds[0]}?authorization=Bearer%20${token}`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: { host: 'boopy.example' } });
      assert.ok(
        [401, 404].includes(response.statusCode),
        `Unexpected data-route status ${response.statusCode} for ${url.split('?')[0]}`,
      );
    }
    assert.equal(boopy.disclosures.length, before);
  });

  it('accepts the configured public or rewritten loopback Host and refuses forwarded-header spoofing', async () => {
    for (const host of ['boopy.example', 'boopy.example:443', '127.0.0.1:47901', 'localhost']) {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { host } });
      assert.equal(response.statusCode, 200);
    }
    for (const host of ['evil.example', 'boopy.example.evil.example']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: {
          ...headers,
          host,
          'x-forwarded-host': 'boopy.example',
          forwarded: 'host=boopy.example;proto=https',
        },
      });
      assert.equal(response.statusCode, 403);
    }
  });

  it('rejects untrusted, null and malformed browser Origins even with a valid bearer', async () => {
    const before = boopy.disclosures.length;
    for (const origin of ['https://evil.example', 'null', 'not-a-url']) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/context',
        headers: { ...headers, origin },
      });
      assert.equal(response.statusCode, 403);
    }
    assert.equal(boopy.disclosures.length, before);
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { ...headers, origin: baseUrl },
    });
    assert.equal(allowed.statusCode, 200);
  });

  it('serves only committed packages, with all-package bearer scope and no raw-media routes', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/context', headers });
    assert.deepEqual(
      list
        .json()
        .results.map((pkg: { id: string }) => pkg.id)
        .sort(),
      packageIds.sort(),
    );
    assert.ok(
      list
        .json()
        .results.every((pkg: { url: string }) => pkg.url.startsWith(`${baseUrl}/v1/context/`)),
    );
    for (const url of [
      `/v1/context/${uncommittedId}`,
      '/v1/sessions',
      `/v1/sessions/${uncommittedId}`,
      '/media/synthetic.jpg',
      '/v1/media/synthetic.jpg',
      '/connector-token',
      '/model-api-key',
    ]) {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 404);
    }
    for (const url of ['/v1/sessions', `/v1/sessions/${uncommittedId}/commit`]) {
      const response = await app.inject({ method: 'POST', url, headers, payload: {} });
      assert.equal(response.statusCode, 404);
    }
    for (const id of packageIds) {
      const response = await app.inject({ method: 'GET', url: `/v1/context/${id}`, headers });
      assert.equal(response.statusCode, 200);
      const pkg = response.json();
      assert.ok(pkg.provenance.utterances.length > 0, 'text provenance is intentionally disclosed');
      assert.ok(!/("jpeg"|"wav"|"apiKey"|"mask")\s*:/.test(response.body));
    }
  });

  it('keeps public OpenAPI metadata free of credentials and describes bearer protection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json',
      headers: { host: 'boopy.example' },
    });
    assert.equal(response.statusCode, 200);
    const spec = response.json();
    assert.deepEqual(spec.servers, [{ url: baseUrl }]);
    assert.deepEqual(spec.security, [{ bearer: [] }]);
    assert.deepEqual(spec.components.securitySchemes.bearer, { type: 'http', scheme: 'bearer' });
    assert.ok(!response.body.includes(token));
    assert.deepEqual(Object.keys(spec.paths).sort(), ['/v1/context', '/v1/context/{id}']);
  });

  it('enforces body and declared-length limits before the MCP handler, and authorizes before parsing', async () => {
    const payload = JSON.stringify({ synthetic: 'x'.repeat(1024 * 1024) });
    const oversized = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, 'content-type': 'application/json' },
      payload,
    });
    assert.equal(oversized.statusCode, 413);
    const malformedLength = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, 'content-type': 'application/json', 'content-length': '1' },
      payload: '{"synthetic":true}',
    });
    assert.equal(malformedLength.statusCode, 400);
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { host: 'boopy.example', 'content-type': 'application/json' },
      payload,
    });
    assert.equal(unauthenticated.statusCode, 401);
  });

  it('journals package-title resource listings as well as full resource reads', async () => {
    const client = new Client({ name: 'synthetic-security-audit', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${localUrl}/mcp`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-boopy-agent': 'resource-audit' },
        },
      }),
    );
    try {
      const before = boopy.disclosures.length;
      const listed = await client.listResources();
      assert.equal(listed.resources.length, 2);
      const disclosures = boopy.disclosures.slice(before);
      assert.equal(disclosures.length, 2);
      assert.ok(
        disclosures.every(
          (d) => d.tool === 'resource-list' && d.agent === 'resource-audit' && d.via === 'mcp',
        ),
      );
      assert.deepEqual(disclosures.map((d) => d.packageId).sort(), packageIds.sort());
      await client.readResource({ uri: `boopy://context/${packageIds[0]}` });
      assert.ok(
        boopy.disclosures.some((d) => d.tool === 'resource' && d.agent === 'resource-audit'),
      );
    } finally {
      await client.close();
    }
  });
});
