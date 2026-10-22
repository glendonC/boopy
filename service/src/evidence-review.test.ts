import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Boopy } from './boopy.ts';
import { ContextPackage } from './contracts.ts';
import { evidenceRecords } from './evidence-contract.ts';
import { connectorApp } from './http/connector.ts';
import { startRequest, testBoopy } from './testing.ts';

it('recall suppresses corrected predecessors across package selection without disclosing replacement', async () => {
  const { boopy, journal } = testBoopy();
  const saved: ContextPackage[] = [];
  for (let index = 0; index < 2; index++) {
    const view = await boopy.start(startRequest('Synthetic desert discussion'));
    const pkg = boopy.package(boopy.commit(view.id).committed?.packageId ?? '');
    assert.ok(pkg);
    saved.push(pkg);
  }
  const predecessor = evidenceRecords(saved[0])[0];
  const successor = evidenceRecords(saved[1])[0];
  assert.ok(predecessor && successor);
  boopy.supersede({ predecessor, successor });
  const options = { token: 'synthetic-review-token', baseUrl: 'http://127.0.0.1', logger: false };
  const app = connectorApp(boopy, { ...options, memory: true });
  const disabled = connectorApp(boopy, options);
  const payload = { packageIds: [saved[0]?.id], query: 'desert Sahara photo', limit: 20 };
  const headers = { authorization: 'Bearer synthetic-review-token' };
  try {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/v1/recall', payload })).statusCode,
      401,
    );
    assert.equal(boopy.disclosures.length, 0);
    assert.equal(
      (await disabled.inject({ method: 'POST', url: '/v1/recall', headers, payload })).statusCode,
      404,
    );
    const response = await app.inject({ method: 'POST', url: '/v1/recall', headers, payload });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.supersededCount, 1);
    assert.ok(
      result.results.every(
        (hit: { evidence: { sourceId: string } }) => hit.evidence.sourceId !== predecessor.sourceId,
      ),
    );
    assert.ok(
      result.results.every(
        (hit: { evidence: { packageId: string } }) => hit.evidence.packageId === saved[0]?.id,
      ),
    );
    assert.equal(boopy.disclosures.length, 1);
    assert.equal(boopy.disclosures[0]?.packageId, saved[0]?.id);
    assert.equal(boopy.disclosures[0]?.tool, 'recall');
  } finally {
    await app.close();
    await disabled.close();
    journal.close();
  }
});

it('REST and MCP recall retain constraints/questions, reject bad scopes and refuse legacy evidence after replay', async () => {
  const { boopy, journal, deps } = testBoopy();
  const view = await boopy.start(startRequest('Synthetic desert discussion'));
  const known = view.items.find((item) => item.label === 'desert');
  const rejected = view.items.find((item) => item.label === 'Tents');
  assert.ok(known && rejected);
  boopy.act(view.id, { itemId: known.id, action: 'known' });
  boopy.act(view.id, { itemId: rejected.id, action: 'reject' });
  const id = boopy.commit(view.id).committed?.packageId;
  const pkg = boopy.package(id ?? '');
  assert.ok(pkg);
  const token = 'synthetic-review-token';
  const options = { token, baseUrl: 'http://127.0.0.1', logger: false, memory: true };
  const app = connectorApp(boopy, options);
  const client = new Client({ name: 'synthetic-recall-review', version: '0.1.0' });
  const headers = { authorization: `Bearer ${token}` };
  try {
    for (const payload of [
      { packageIds: [], query: 'desert' },
      { packageIds: [id], query: '', limit: 1 },
      { packageIds: [id], query: 'desert', limit: 21 },
    ]) {
      assert.equal(
        (await app.inject({ method: 'POST', url: '/v1/recall', headers, payload })).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/recall',
          headers,
          payload: { packageIds: ['missing'], query: 'desert' },
        })
      ).statusCode,
      404,
    );
    assert.equal(boopy.disclosures.length, 0);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers },
      }),
    );
    const fetched = await client.callTool({
      name: 'recall',
      arguments: {
        packageIds: [id],
        query: 'desert',
        limit: 20,
      },
    });
    assert.ok(!fetched.isError);
    const block = fetched.content[0];
    assert.equal(block?.type, 'text');
    const result = JSON.parse((block as { text: string }).text);
    assert.ok(result.constraints.some((record: { itemId: string }) => record.itemId === known.id));
    assert.ok(
      result.constraints.some((record: { itemId: string }) => record.itemId === rejected.id),
    );
    assert.ok(result.openQuestions.length > 0);
    assert.ok(
      result.results.every((hit: { evidence: { disposition: string } }) =>
        ['context', 'intent'].includes(hit.evidence.disposition),
      ),
    );
    assert.equal(boopy.disclosures.length, 1);
    assert.equal(boopy.disclosures[0]?.via, 'mcp');
    const legacy = ContextPackage.parse({ ...pkg, version: 1, evidence: undefined });
    journal.append(
      {
        type: 'context.committed',
        session: pkg.sessionId,
        actor: 'system',
        data: { packageId: pkg.id, package: legacy },
      },
      'synthetic-legacy-replay',
      '1970-01-01T12:00:00Z',
    );
    const replayed = new Boopy(deps);
    assert.equal(replayed.package(pkg.id)?.version, 1);
    const legacyApp = connectorApp(replayed, options);
    try {
      const response = await legacyApp.inject({
        method: 'POST',
        url: '/v1/recall',
        headers,
        payload: { packageIds: [pkg.id], query: 'desert' },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(replayed.disclosures.length, 1);
    } finally {
      await legacyApp.close();
    }
  } finally {
    await client.close();
    await app.close();
    journal.close();
  }
});

it('recall preserves targeted notes and rejection reasons with distinct verification', async () => {
  const { boopy, journal } = testBoopy();
  const view = await boopy.start(startRequest('Synthetic desert discussion'));
  const photo = view.items.find((item) => item.label === 'desert');
  const tents = view.items.find((item) => item.label === 'Tents');
  assert.ok(photo && tents);
  await boopy.utter(view.id, {
    speech: { text: 'That was a photo from last year' },
    cues: { targetItemId: photo.id },
  });
  await boopy.utter(view.id, {
    speech: { text: 'Not that, we did not camp' },
    cues: { targetItemId: tents.id },
  });
  const id = boopy.commit(view.id).committed?.packageId;
  assert.ok(id);
  const app = connectorApp(boopy, {
    token: 'synthetic-review-token',
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/recall',
      headers: { authorization: 'Bearer synthetic-review-token' },
      payload: { packageIds: [id], query: 'desert photo last year', limit: 20 },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    const recalled = result.results.find(
      (hit: { evidence: { itemId: string } }) => hit.evidence.itemId === photo.id,
    )?.evidence;
    assert.ok(recalled);
    assert.equal(recalled.note, 'That was a photo from last year');
    assert.equal(recalled.verification, 'accepted');
    const rejected = result.constraints.find(
      (record: { itemId: string }) => record.itemId === tents.id,
    );
    assert.ok(rejected);
    assert.equal(rejected.note, 'we did not camp');
    assert.equal(rejected.disposition, 'rejected');
    assert.equal(rejected.verification, 'unconfirmed');
  } finally {
    await app.close();
    journal.close();
  }
});

it('all full read paths warn about supersession without leaking extra successor fields or rewriting snapshots', async () => {
  const { boopy, journal } = testBoopy();
  const packages: ContextPackage[] = [];
  for (const said of ['Synthetic original view', 'Synthetic successor view']) {
    const view = await boopy.start(startRequest(said));
    const pkg = boopy.package(boopy.commit(view.id).committed?.packageId ?? '');
    assert.ok(pkg);
    packages.push(pkg);
  }
  const original = packages[0];
  const replacement = packages[1];
  assert.ok(original && replacement);
  const before = JSON.stringify(boopy.package(original.id));
  const predecessor = evidenceRecords(original)[0];
  const source = evidenceRecords(replacement)[0];
  assert.ok(predecessor && source);
  const successor = {
    ...source,
    label: 'synthetic-unselected-secret-label',
    note: 'synthetic-unselected-secret-note',
    text: ['synthetic-unselected-secret-text'],
  };
  const link = boopy.supersede({ predecessor, successor });
  const expected = {
    predecessor: { packageId: predecessor.packageId, itemId: predecessor.itemId },
    successor: { packageId: successor.packageId, itemId: successor.itemId },
  };
  assert.deepEqual(link.predecessor, expected.predecessor);
  assert.deepEqual(link.successor, expected.successor);
  assert.deepEqual(
    journal.all().find((event) => event.type === 'evidence.superseded')?.data,
    expected,
  );
  const headers = { authorization: 'Bearer synthetic-review-token' };
  const app = connectorApp(boopy, {
    token: 'synthetic-review-token',
    baseUrl: 'http://127.0.0.1',
    logger: false,
  });
  const client = new Client({ name: 'synthetic-overlay-review', version: '0.1.0' });
  const assertWarning = (text: string) => {
    assert.match(text, /Later human corrections/);
    assert.match(text, /Do not use this old claim for a current answer/);
    assert.match(text, /Linking does not confirm the successor/);
    assert.ok(text.includes(successor.packageId));
    assert.doesNotMatch(text, /synthetic-unselected-secret/);
  };
  try {
    const rest = await app.inject({ method: 'GET', url: `/v1/context/${original.id}`, headers });
    assert.equal(rest.statusCode, 200);
    const delivered = rest.json();
    assert.deepEqual(delivered.correctionOverlay.supersessions, [link]);
    assertWarning(delivered.text);
    assert.doesNotMatch(JSON.stringify(delivered.correctionOverlay), /synthetic-unselected-secret/);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers },
      }),
    );
    const fetched = await client.callTool({ name: 'fetch', arguments: { id: original.id } });
    assert.ok(!fetched.isError);
    const block = fetched.content[0];
    assert.equal(block?.type, 'text');
    const document = JSON.parse((block as { text: string }).text);
    assertWarning(document.text);
    assert.deepEqual(document.metadata.package.correctionOverlay.supersessions, [link]);
    const resource = await client.readResource({ uri: `boopy://context/${original.id}` });
    const content = resource.contents[0];
    assert.ok(content && 'text' in content);
    assertWarning(content.text);
    assert.equal(JSON.stringify(boopy.package(original.id)), before);
    assert.equal(boopy.disclosures.length, 3);
    assert.ok(boopy.disclosures.every((read) => read.packageId === original.id));
  } finally {
    await client.close();
    await app.close();
    journal.close();
  }
});
