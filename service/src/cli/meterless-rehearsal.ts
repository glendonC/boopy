/** Real adopted H-MEM through ephemeral authenticated REST/MCP; all evidence is synthetic. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ContextPackage } from '../contracts.ts';
import { type EvidenceRecord, evidenceRecords } from '../evidence-contract.ts';
import { connectorApp } from '../http/connector.ts';
import { startRequest, testBoopy } from '../testing.ts';

type Recall = {
  engine: string;
  results: { evidence: EvidenceRecord; relevance: number; retrievalConfidence: number }[];
  constraints: EvidenceRecord[];
  openQuestions: EvidenceRecord[];
  supersededCount: number;
};
export async function meterlessRehearsal() {
  const { boopy, journal } = testBoopy();
  const token = randomBytes(32).toString('hex');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const options = { token, baseUrl: 'http://127.0.0.1', logger: false };
  const enabled = connectorApp(boopy, { ...options, memory: true });
  const disabled = connectorApp(boopy, { ...options, memory: false });
  const client = new Client({ name: 'synthetic-meterless-rehearsal', version: '0.1.0' });
  const disabledClient = new Client({ name: 'synthetic-core-rehearsal', version: '0.1.0' });
  const packages: ContextPackage[] = [];
  const make = async (corrected: boolean) => {
    let view = await boopy.start(startRequest('Synthetic Sahara travel practice'));
    const camels = view.items.find((item) => item.label === 'Camels');
    const known = view.items.find((item) => item.label === 'desert');
    const rejected = view.items.find((item) => item.label === 'Tents');
    assert.ok(camels && known && rejected);
    if (corrected) {
      view = await boopy.utter(view.id, {
        speech: { text: "It's a dromedary" },
        cues: { targetItemId: camels.id },
      });
      boopy.act(view.id, { itemId: known.id, action: 'known' });
      boopy.act(view.id, { itemId: rejected.id, action: 'reject' });
      await boopy.utter(view.id, { speech: { text: 'I also want to practice 사하라 여행 낙타' } });
    }
    const pkg = boopy.package(boopy.commit(view.id).committed?.packageId ?? '');
    assert.ok(pkg);
    packages.push(pkg);
    return { pkg, camelId: camels.id };
  };
  try {
    const old = await make(false);
    const correction = await make(true);
    const distractor = await make(false);
    const unselected = await make(false);
    const predecessor = evidenceRecords(old.pkg).find((record) => record.itemId === old.camelId);
    const successor = evidenceRecords(correction.pkg).find(
      (record) => record.itemId === correction.camelId,
    );
    assert.ok(predecessor && successor);
    assert.equal(successor.verification, 'corrected');
    assert.ok(successor.humanActions.length > 0);
    const link = boopy.supersede({ predecessor, successor });
    assert.deepEqual(boopy.supersede({ predecessor, successor }), link);
    const snapshots = packages.map((pkg) => JSON.stringify(boopy.package(pkg.id)));
    for (const app of [enabled, disabled]) await app.listen({ host: '127.0.0.1', port: 0 });
    const base = (app: typeof enabled) =>
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const query = async (app: typeof enabled, packageIds: string[], text: string) =>
      fetch(`${base(app)}/v1/recall`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ packageIds, query: text, limit: 20 }),
      });
    assert.equal(
      (
        await fetch(`${base(enabled)}/v1/recall`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ packageIds: [old.pkg.id], query: 'camels' }),
        })
      ).status,
      401,
    );
    assert.equal((await query(disabled, [old.pkg.id], 'camels')).status, 404);
    assert.equal(boopy.disclosures.length, 0);
    // Core package fetch still works with memory disabled; no ingestion/config dependency.
    assert.equal(
      (await fetch(`${base(disabled)}/v1/context/${old.pkg.id}`, { headers })).status,
      200,
    );
    await disabledClient.connect(
      new StreamableHTTPClientTransport(new URL(`${base(disabled)}/mcp`), {
        requestInit: { headers },
      }),
    );
    assert.equal(
      (await disabledClient.listTools()).tools.some((tool) => tool.name === 'recall'),
      false,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base(enabled)}/mcp`), {
        requestInit: { headers },
      }),
    );
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'recall'));
    const selected = [old.pkg.id, correction.pkg.id, distractor.pkg.id];
    const rest = await query(enabled, selected, 'camels dunes photo');
    assert.equal(rest.status, 200);
    const english = (await rest.json()) as Recall;
    assert.equal(english.engine, 'hmem-subset');
    assert.equal(english.supersededCount, 1);
    assert.equal(
      english.results.some((hit) => hit.evidence.sourceId === predecessor.sourceId),
      false,
    );
    assert.ok(
      english.results.some(
        (hit) =>
          hit.evidence.packageId === distractor.pkg.id &&
          hit.evidence.itemId === distractor.camelId,
      ),
    );
    assert.ok(
      english.results.some(
        (hit) => hit.evidence.verification === 'accepted' && hit.evidence.modelConfidence !== null,
      ),
    );
    const called = await client.callTool({
      name: 'recall',
      arguments: { packageIds: selected, query: '사하라 여행 낙타', limit: 20 },
    });
    assert.ok(!called.isError);
    const block = called.content[0];
    assert.equal(block?.type, 'text');
    const korean = JSON.parse((block as { text: string }).text) as Recall;
    const correctionResponse = await query(enabled, selected, 'dromedary');
    assert.equal(correctionResponse.status, 200);
    const correctionRecall = (await correctionResponse.json()) as Recall;
    const corrected = correctionRecall.results.find(
      (hit) => hit.evidence.sourceId === successor.sourceId,
    );
    assert.deepEqual(corrected?.evidence, successor);
    const narrowKoreanCorrectedHit = korean.results.some(
      (hit) => hit.evidence.sourceId === successor.sourceId,
    );
    assert.equal(narrowKoreanCorrectedHit, true);
    const singleNoun = (await (await query(enabled, selected, '낙타')).json()) as Recall;
    assert.ok(singleNoun.results.some((hit) => hit.evidence.sourceId === successor.sourceId));
    assert.ok(
      korean.results.some(
        (hit) => hit.evidence.verification === 'authored' && hit.evidence.modelConfidence === null,
      ),
    );
    assert.ok(korean.constraints.some((record) => record.disposition === 'known'));
    assert.ok(korean.constraints.some((record) => record.disposition === 'rejected'));
    assert.ok(korean.openQuestions.length > 0);
    for (const result of [english, korean, correctionRecall]) {
      const returned = [
        ...result.results.map((hit) => hit.evidence),
        ...result.constraints,
        ...result.openQuestions,
      ];
      assert.ok(
        returned.every(
          (record) => selected.includes(record.packageId) && record.packageId !== unselected.pkg.id,
        ),
      );
    }
    const oldOnly = (await (await query(enabled, [old.pkg.id], 'camels')).json()) as Recall;
    assert.equal(oldOnly.supersededCount, 1);
    assert.equal(
      oldOnly.results.some((hit) =>
        [predecessor.sourceId, successor.sourceId].includes(hit.evidence.sourceId),
      ),
      false,
    );
    const beforeFailure = boopy.disclosures.length;
    assert.equal((await query(enabled, ['missing-synthetic-package'], 'camels')).status, 404);
    assert.equal(boopy.disclosures.length, beforeFailure);
    const replay = (await (
      await query(enabled, [...selected, selected[0] as string], 'camels dunes photo')
    ).json()) as Recall;
    assert.deepEqual(replay, english);
    assert.deepEqual(
      packages.map((pkg) => JSON.stringify(boopy.package(pkg.id))),
      snapshots,
    );
    assert.ok(boopy.disclosures.some((entry) => entry.tool === 'recall' && entry.via === 'mcp'));
    return {
      passed: true,
      synthetic: true,
      engine: 'real pinned H-MEM subset',
      pin: '0aa7417ba5c826396d91e891328be78c45e6fbf6',
      transport: ['REST', 'MCP'],
      storage: 'in-memory',
      loopbackOnly: true,
      englishHits: english.results.length,
      koreanHits: korean.results.length,
      correctedRecallHits: correctionRecall.results.length,
      narrowKoreanCorrectedHit,
      supersededExcluded: 1,
      selectedScopeOnly: true,
      disabledCoreRead: true,
      correctionMetadataExact: true,
      snapshotsUnchanged: true,
      limitation:
        'Lexical English/Korean recall; no cross-language semantics, actual Muse use, full conformance or sponsor qualification.',
    };
  } finally {
    await client.close();
    await disabledClient.close();
    for (const app of [enabled, disabled]) {
      app.server.closeAllConnections();
      await app.close();
    }
    journal.close();
  }
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await meterlessRehearsal(), null, 2));
  } catch {
    console.error('Isolated synthetic Meterless rehearsal failed; run its test for assertions.');
    process.exitCode = 1;
  }
}
