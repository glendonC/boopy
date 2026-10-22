import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { evidenceRecords } from '../evidence-contract.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { connectorApp } from './connector.ts';

const model = 'nvidia/nemotron-3-embed-1b';
const revision = 'c0c9fea93ea424587517f2c59e20db9f1d6bf615';
const headers = { host: '127.0.0.1', authorization: 'Bearer synthetic-only' };
test('REST and MCP await semantic ranking of exact selected eligible sources, retaining confidence and constraints', async () => {
  const { boopy, journal } = testBoopy();
  const first = await boopy.start(startRequest('Synthetic Sahara trip Korean practice.'));
  const rejected = first.items.find((item) => item.label === 'Tents');
  assert.ok(rejected);
  boopy.act(first.id, { itemId: rejected.id, action: 'reject' });
  const saved = boopy.commit(first.id).committed;
  assert.ok(saved);
  const other = await boopy.start(startRequest('Unselected synthetic trip.'));
  const otherSaved = boopy.commit(other.id).committed;
  assert.ok(otherSaved);
  const pkg = boopy.package(saved.packageId);
  assert.ok(pkg);
  const successorPackage = boopy.package(otherSaved.packageId);
  assert.ok(successorPackage);
  const predecessor = evidenceRecords(pkg).find((record) => record.disposition === 'context');
  const successor = evidenceRecords(successorPackage).find(
    (record) => record.disposition === 'context',
  );
  assert.ok(predecessor && successor);
  boopy.supersede({ predecessor, successor });
  const eligible = evidenceRecords(pkg)
    .filter((record) => record.sourceId !== predecessor.sourceId)
    .filter((record) => ['context', 'intent'].includes(record.disposition));
  const expected = eligible.map((record) => record.sourceId).sort();
  let calls = 0;
  const app = connectorApp(boopy, {
    token: 'synthetic-only',
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
    semanticRanker: {
      async rank(request) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        calls++;
        assert.deepEqual(
          request.candidates.map((candidate) => candidate.sourceId).sort(),
          expected,
        );
        assert.equal(
          request.candidates.some((candidate) => candidate.sourceId.endsWith(`:${rejected.id}`)),
          false,
        );
        return {
          model,
          revision,
          candidates: request.candidates.map((candidate) => ({
            sourceId: candidate.sourceId,
            score: 1,
          })),
        };
      },
    },
  });
  const payload = { packageIds: [saved.packageId], query: 'Synthetic Sahara', limit: 20 };
  const client = new Client({ name: 'synthetic-semantic', version: '1' });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/recall', headers, payload });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.semantic, { status: 'available', provider: 'nvidia', model, revision });
    assert.ok(body.constraints.some((record: { itemId: string }) => record.itemId === rejected.id));
    for (const hit of body.results) {
      const original = eligible.find((record) => record.sourceId === hit.evidence.sourceId);
      assert.deepEqual(hit.evidence, original);
      assert.equal(hit.retrievalConfidence, 1);
    }
    await app.listen({ host: '127.0.0.1', port: 0 });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`),
        { requestInit: { headers: { authorization: 'Bearer synthetic-only' } } },
      ),
    );
    const result = await client.callTool({ name: 'recall', arguments: payload });
    const content = result.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0]?.text ?? '{}').semantic.status, 'available');
    assert.equal(calls, 2);
  } finally {
    await client.close();
    await app.close();
    journal.close();
  }
});

test('malformed semantic responses fail closed to unchanged lexical results', async () => {
  const { boopy, journal } = testBoopy();
  const view = await boopy.start(startRequest('Synthetic trip.'));
  const packageId = boopy.commit(view.id).committed?.packageId;
  assert.ok(packageId);
  const payload = { packageIds: [packageId], query: 'Sahara travel photo' };
  const plain = connectorApp(boopy, {
    token: 'synthetic-only',
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
  });
  try {
    const baseline = (
      await plain.inject({ method: 'POST', url: '/v1/recall', headers, payload })
    ).json();
    assert.equal(baseline.semantic.status, 'disabled');
    for (const kind of [
      'throw',
      'duplicate',
      'substitute',
      'missing',
      'nonfinite',
      'range',
      'model',
    ]) {
      const app = connectorApp(boopy, {
        token: 'synthetic-only',
        baseUrl: 'http://127.0.0.1',
        logger: false,
        memory: true,
        semanticRanker: {
          async rank(request) {
            if (kind === 'throw') throw new Error('Synthetic worker failure');
            let candidates = request.candidates.map((candidate) => ({
              sourceId: candidate.sourceId,
              score: 0.5,
            }));
            if (kind === 'duplicate')
              candidates.push(candidates[0] as { sourceId: string; score: number });
            if (kind === 'substitute' && candidates[0])
              candidates[0].sourceId = 'unselected:substitute';
            if (kind === 'missing') candidates = [];
            if (kind === 'nonfinite' && candidates[0]) candidates[0].score = Number.NaN;
            if (kind === 'range' && candidates[0]) candidates[0].score = 1.01;
            return { model: kind === 'model' ? 'unknown' : model, revision, candidates };
          },
        },
      });
      try {
        const body = (
          await app.inject({ method: 'POST', url: '/v1/recall', headers, payload })
        ).json();
        assert.equal(body.semantic.status, 'unavailable', kind);
        assert.deepEqual(body.results, baseline.results, kind);
      } finally {
        await app.close();
      }
    }
  } finally {
    await plain.close();
    journal.close();
  }
});

test('more than twenty eligible selected sources skips worker and preserves lexical recall', async () => {
  const { boopy, journal } = testBoopy();
  const packageIds: string[] = [];
  let count = 0;
  for (let index = 0; index < 8; index++) {
    const view = await boopy.start(startRequest('Synthetic travel scope'));
    const id = boopy.commit(view.id).committed?.packageId;
    assert.ok(id);
    packageIds.push(id);
    const pkg = boopy.package(id);
    assert.ok(pkg);
    count += evidenceRecords(pkg).filter((record) =>
      ['context', 'intent'].includes(record.disposition),
    ).length;
  }
  assert.ok(count > 20);
  let calls = 0;
  const app = connectorApp(boopy, {
    token: 'synthetic-only',
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
    semanticRanker: {
      async rank() {
        calls++;
        throw new Error('must not execute');
      },
    },
  });
  const plain = connectorApp(boopy, {
    token: 'synthetic-only',
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
  });
  try {
    const payload = { packageIds, query: 'Sahara photo', limit: 20 };
    const body = (await app.inject({ method: 'POST', url: '/v1/recall', headers, payload })).json();
    const baseline = (
      await plain.inject({ method: 'POST', url: '/v1/recall', headers, payload })
    ).json();
    assert.equal(calls, 0);
    assert.equal(body.semantic.status, 'unavailable');
    assert.deepEqual(body.results, baseline.results);
  } finally {
    await app.close();
    await plain.close();
    journal.close();
  }
});

test('a correction committed while ranker awaits cannot reappear in semantic results', async () => {
  const { boopy, journal } = testBoopy();
  const packages = [];
  for (let index = 0; index < 2; index++) {
    const view = await boopy.start(startRequest('Synthetic pending correction'));
    const pkg = boopy.package(boopy.commit(view.id).committed?.packageId ?? '');
    assert.ok(pkg);
    packages.push(pkg);
  }
  assert.ok(packages[0] && packages[1]);
  const predecessor = evidenceRecords(packages[0]).find(
    (record) => record.disposition === 'context',
  );
  const successor = evidenceRecords(packages[1]).find((record) => record.disposition === 'context');
  assert.ok(predecessor && successor);
  const app = connectorApp(boopy, {
    token: 'synthetic-only',
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: true,
    semanticRanker: {
      async rank(request) {
        await Promise.resolve();
        boopy.supersede({ predecessor, successor });
        return {
          model,
          revision,
          candidates: request.candidates.map((candidate) => ({
            sourceId: candidate.sourceId,
            score: 1,
          })),
        };
      },
    },
  });
  try {
    const body = (
      await app.inject({
        method: 'POST',
        url: '/v1/recall',
        headers,
        payload: { packageIds: [predecessor.packageId], query: 'Synthetic', limit: 20 },
      })
    ).json();
    assert.equal(body.semantic.status, 'available');
    assert.equal(body.supersededCount, 1);
    assert.ok(
      body.results.every(
        (hit: { evidence: { sourceId: string } }) =>
          ![predecessor.sourceId, successor.sourceId].includes(hit.evidence.sourceId),
      ),
    );
  } finally {
    await app.close();
    journal.close();
  }
});
