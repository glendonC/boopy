import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  Client,
  StreamableHTTPClientTransport,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/client';
import { SessionView } from '../contracts.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';
import { headsetApp } from './headset.ts';

describe('headset API', () => {
  const { boopy } = testBoopy();
  const app = headsetApp(boopy, { logger: false });
  after(() => app.close());

  it('reports only safe configured segmenter metadata without calling a provider', async () => {
    const disabled = await app.inject({ method: 'GET', url: '/v1/health' });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.json().segmenter, null);
    let calls = 0;
    const enabled = headsetApp(
      testBoopy({
        segmenter: {
          provider: 'meta',
          model: 'sam-3.1',
          segment: async () => {
            calls++;
            return { outcome: 'no-match', latencyMs: 0, confidence: null };
          },
        },
      }).boopy,
      { logger: false },
    );
    try {
      const response = await enabled.inject({ method: 'GET', url: '/v1/health' });
      assert.deepEqual(response.json(), {
        ok: true,
        service: 'boopy',
        speechOutputAvailable: false,
        handoffPreparationAvailable: false,
        interpreter: { provider: 'fixture', model: 'recorded-desert-trip' },
        segmenter: { provider: 'meta', model: 'sam-3.1' },
        liveScene: null,
      });
      assert.equal(calls, 0);
    } finally {
      await enabled.close();
    }
  });

  it('starts a session and answers with a valid session view', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { host: '127.0.0.1:47900' },
      payload: startRequest('What is this?'),
    });
    assert.equal(response.statusCode, 200);
    const view = SessionView.parse(response.json());
    assert.ok(view.items.length > 0);
    const action = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${view.id}/actions`,
      headers: { host: 'localhost' },
      payload: { itemId: view.items[1]?.id, action: 'confirm' },
    });
    assert.equal(action.statusCode, 200);
    assert.equal(SessionView.parse(action.json()).items[1]?.status, 'confirmed');
  });

  it('refuses hosts other than loopback, against DNS rebinding', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { host: 'evil.example' },
    });
    assert.equal(response.statusCode, 403);
  });

  it('says which field is wrong in a bad request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { host: '127.0.0.1' },
      payload: {
        ...startRequest('hi'),
        cues: { gaze: { point: { x: 2, y: 0 }, onSurface: true } },
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /^cues\.gaze\.point\.x:/);
  });

  it('answers 404 for an unknown session', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions/nope',
      headers: { host: '127.0.0.1' },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'no_session');
  });
});

describe('connector', async () => {
  const token = 'test-token-0123456789';
  const { boopy } = testBoopy();
  const view = await boopy.start(
    startRequest('I want to practice talking about this trip in Korean.'),
  );
  const tents = view.items.find((item) => item.label === 'Tents');
  boopy.act(view.id, { itemId: tents?.id ?? '', action: 'reject' });
  const committed = boopy.commit(view.id);
  const packageId = committed.committed?.packageId ?? '';
  let base = '';
  const app = connectorApp(boopy, { token, baseUrl: 'http://127.0.0.1:47901', logger: false });

  before(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(() => app.close());

  it('refuses requests without the token', async () => {
    const response = await fetch(`${base}/v1/context`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(mcp.status, 401);
  });

  it('serves its OpenAPI document without a token', async () => {
    const response = await fetch(`${base}/openapi.json`);
    assert.equal(response.status, 200);
    const spec = await response.json();
    assert.equal(spec.openapi, '3.1.0');
    assert.match(spec.info.title, /committed context/);
    assert.match(spec.info.description, /accepted.*not individually confirmed/);
    assert.match(spec.info.description, /does not establish that every item was reviewed/);
    assert.match(spec.paths['/v1/context'].get.summary, /committed context/);
    assert.doesNotMatch(JSON.stringify(spec), /verified context|context the user verified/);
  });

  it('lists and returns packages over REST, recording each read', async () => {
    const headers = { authorization: `Bearer ${token}`, 'x-boopy-agent': 'rest-test' };
    const list = await (await fetch(`${base}/v1/context?query=korean`, { headers })).json();
    assert.equal(list.results[0].id, packageId);
    const pkg = await (await fetch(`${base}/v1/context/${packageId}`, { headers })).json();
    assert.equal(pkg.type, 'boopy.context-package');
    assert.ok(boopy.disclosures.some((d) => d.agent === 'rest-test' && d.tool === 'get'));
  });

  for (const mode of ['legacy', 'auto'] as const) {
    it(`serves MCP search and fetch to a client negotiating ${mode}`, async () => {
      const client = new Client(
        { name: `boopy-test-${mode}`, version: '1.0.0' },
        { versionNegotiation: { mode } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { authorization: `Bearer ${token}`, 'x-boopy-agent': `mcp-${mode}` },
        },
      });
      await client.connect(transport);
      try {
        const version = client.getNegotiatedProtocolVersion();
        if (mode === 'auto') {
          assert.equal(client.getProtocolEra(), 'modern');
          assert.equal(SUPPORTED_PROTOCOL_VERSIONS.includes(version ?? ''), false);
        } else {
          assert.equal(client.getProtocolEra(), 'legacy');
          assert.equal(SUPPORTED_PROTOCOL_VERSIONS.includes(version ?? ''), true);
        }
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['fetch', 'search']);
        assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));
        assert.ok(tools.tools.every((tool) => /committed context/.test(tool.title ?? '')));
        assert.match(
          tools.tools.find((tool) => tool.name === 'search')?.description ?? '',
          /unconfirmed model proposals/,
        );
        const instructions = client.getInstructions() ?? '';
        assert.match(instructions, /does not establish that every item was reviewed or confirmed/);
        assert.match(instructions, /Never present "accepted" items as confirmed/);
        const templates = await client.listResourceTemplates();
        assert.match(templates.resourceTemplates[0]?.title ?? '', /Committed context/);
        assert.match(
          templates.resourceTemplates[0]?.description ?? '',
          /unconfirmed model proposals/,
        );
        assert.doesNotMatch(
          JSON.stringify({ instructions, tools, templates }),
          /verified context|context the user verified/i,
        );
        const search = await client.callTool({
          name: 'search',
          arguments: { query: 'desert trip' },
        });
        const results = JSON.parse((search.content[0] as { text: string }).text).results;
        assert.equal(results[0].id, packageId);
        const fetched = await client.callTool({ name: 'fetch', arguments: { id: packageId } });
        const document = JSON.parse((fetched.content[0] as { text: string }).text);
        assert.match(document.text, /Rejected by the person: Tents/);
        assert.match(document.text, /not individually confirmed/);
        assert.doesNotMatch(document.text, /The person reviewed this in the headset/);
        assert.equal(document.metadata.package.id, packageId);
        assert.ok(boopy.disclosures.some((d) => d.agent === `mcp-${mode}` && d.tool === 'fetch'));
      } finally {
        await client.close();
      }
    });
  }
});
