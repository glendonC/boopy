/** Isolated synthetic transport preflight; never a consumer Muse connection. */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ContextPackage } from '../contracts.ts';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';

export async function runMusePreflight() {
  const { boopy, journal } = testBoopy();
  const token = 'disposable-synthetic-preflight-token';
  const app = connectorApp(boopy, { token, baseUrl: 'http://127.0.0.1', logger: false });
  const client = new Client({ name: 'boopy-synthetic-preflight', version: '0.1.0' });
  try {
    const view = await boopy.start(
      startRequest('Synthetic context for consumer fetch validation.'),
    );
    const targets = view.items.filter((item) => item.id !== view.intentId);
    assert.ok(targets.length >= 3);
    boopy.act(view.id, { itemId: targets[0]?.id ?? '', action: 'confirm' });
    boopy.act(view.id, { itemId: targets[1]?.id ?? '', action: 'known' });
    boopy.act(view.id, { itemId: targets[2]?.id ?? '', action: 'reject' });
    const id = boopy.commit(view.id).committed?.packageId;
    assert.ok(id);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    for (const authorization of [undefined, 'Bearer wrong-synthetic-token']) {
      const denied: Response = await fetch(`${base}/v1/context/${id}`, {
        headers: authorization ? { authorization } : {},
      });
      assert.equal(denied.status, 401);
    }
    assert.equal(boopy.disclosures.length, 0);
    const rest = await fetch(`${base}/v1/context/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(rest.status, 200);
    const pkg = ContextPackage.parse(await rest.json());
    assert.equal(pkg.id, id);
    assert.equal(pkg.known.length, 1);
    assert.equal(pkg.rejected.length, 1);
    assert.ok(pkg.items.some((item) => item.verification === 'accepted'));
    assert.ok(pkg.items.some((item) => item.verification === 'confirmed'));
    assert.match(pkg.text, /Already known by the person/);
    assert.match(pkg.text, /Rejected by the person/);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const fetched = await client.callTool({ name: 'fetch', arguments: { id } });
    assert.ok(!fetched.isError);
    const block = fetched.content[0];
    assert.equal(block?.type, 'text');
    const document = JSON.parse((block as { text: string }).text);
    assert.equal(document.id, id);
    assert.deepEqual(document.metadata.package, pkg);
    assert.equal(boopy.disclosures.length, 2);
    for (const [via, tool] of [
      ['rest', 'get'],
      ['mcp', 'fetch'],
    ]) {
      assert.ok(
        boopy.disclosures.some(
          (event) => event.packageId === id && event.via === via && event.tool === tool,
        ),
      );
    }
    return {
      synthetic: true,
      loopbackOnly: true,
      packages: 1,
      fullFetchDisclosures: 2,
      restFetch: 'passed',
      mcpFetch: 'passed',
      verificationPreserved: 'passed',
      unauthorizedReads: 'denied',
      actualMuse: 'unverified',
      scheduling: 'unverified',
      mediaDelivery: 'unverified',
    } as const;
  } finally {
    await client.close();
    await app.close();
    journal.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runMusePreflight()));
  } catch {
    console.error('Synthetic Muse preflight failed; actual Muse remains unverified.');
    process.exitCode = 1;
  }
}
