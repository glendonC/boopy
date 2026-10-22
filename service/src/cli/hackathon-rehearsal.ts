/** Same synthetic source chain across routes, private manual export and optional real H-MEM. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type ContextPackage, SessionView } from '../contracts.ts';
import { type EvidenceRecord, evidenceRecords, evidenceSourceId } from '../evidence-contract.ts';
import { HandoffPreparation, type HandoffPreparationReceipt } from '../handoff-preparation.ts';
import {
  ReferenceRow,
  renderSelectedSupplement,
  type SelectedSupplement,
  type SyntheticReferenceRow,
} from '../handoff-supplement.ts';
import { connectorApp } from '../http/connector.ts';
import { headsetApp } from '../http/headset.ts';
import { NvidiaEmbeddingWorker } from '../memory/nvidia.ts';
import type { RecallHit } from '../memory/recall.ts';
import type { lookupZetarisReference } from '../references/zetaris.ts';
import { exportHandoff } from './export-handoff.ts';
import { exportPrepared } from './export-prepared.ts';

export { renderSelectedSupplement } from '../handoff-supplement.ts';

import { providedSyntheticReferences } from '../provided-synthetic-reference.ts';
import { startRequest, testBoopy } from '../testing.ts';

export type SyntheticReferenceProvider = (selection: {
  packageIds: readonly string[];
  baselinePackageId: string;
  evidence: readonly EvidenceRecord[];
}) => Promise<{ mode: 'synthetic-contract'; rows: SyntheticReferenceRow[] }>;
type RecallResult = {
  engine: string;
  results: RecallHit[];
  constraints: EvidenceRecord[];
  openQuestions: EvidenceRecord[];
  supersededCount: number;
  semantic?: SelectedSupplement['memory']['semantic'];
};

export async function hackathonRehearsal(
  options: {
    memory?: boolean;
    memoryUnavailable?: boolean;
    semanticRanker?: Pick<NvidiaEmbeddingWorker, 'rank'>;
    referenceLookup?: typeof lookupZetarisReference;
    references?: SyntheticReferenceProvider;
    referenceReceiptPath?: string;
    referenceCredentials?: string;
    artifactDirectory?: string;
  } = {},
) {
  const test = testBoopy();
  // This retained rehearsal reproduces the already-recorded synthetic receipt exactly.
  // Its legacy Add path lowercased the short label but capitalized the statement. Author
  // that historical fixture shape before append; do not alter current Add behavior or hashes.
  const append = test.journal.append.bind(test.journal);
  test.journal.append = (event, id, at) => {
    if (
      event.type === 'item.corrected' &&
      event.data.op === 'add' &&
      event.data.item.origin === 'person' &&
      event.data.item.statement === 'I saw the synthetic dunes before noon.'
    ) {
      event = structuredClone(event);
      if (event.type === 'item.corrected' && event.data.op === 'add')
        event.data.item.label = 'i saw the synthetic dunes';
    }
    return append(event, id, at);
  };
  const memory = options.memory ?? true;
  const token = randomBytes(32).toString('hex');
  const directory = await mkdtemp(join(tmpdir(), 'boopy-composed-synthetic-'));
  const destination = options.artifactDirectory ? resolve(options.artifactDirectory) : directory;
  let port = 0;
  let observedExport: Awaited<ReturnType<typeof exportHandoff>> | undefined;
  const preparation = new HandoffPreparation({
    journal: test.journal,
    dataDir: directory,
    outputRoot: join(directory, 'preparations'),
    get port() {
      return port;
    },
    packageForId: (id) => test.boopy.package(id),
    sessionForId: (id) => test.boopy.view(id),
    supersessions: () => test.boopy.supersessions,
    referenceCredentialFile: options.referenceCredentials,
    compose: async (input, dependencies) => {
      observedExport = await exportHandoff(
        { ...input, synthetic: true },
        {
          ...dependencies,
          ...(options.referenceLookup ? { lookupReference: options.referenceLookup } : {}),
        },
      );
      return observedExport;
    },
  });
  const connector = connectorApp(test.boopy, {
    token,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory: memory && !options.memoryUnavailable,
    semanticRanker: options.semanticRanker,
    handoff: preparation,
  });
  await connector.listen({ host: '127.0.0.1', port: 0 });
  port = (connector.server.address() as AddressInfo).port;
  const headset = headsetApp(test.boopy, { logger: false, handoff: preparation });
  const client = new Client({ name: 'synthetic-composed-rehearsal', version: '1.0.0' });
  try {
    if (options.artifactDirectory) {
      const info = await stat(destination);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0)
        throw new Error('Choose an existing private output directory.');
    }
    await writeFile(join(directory, 'connector-token'), token, { mode: 0o600 });
    const route = async (url: string, payload: unknown) => {
      const response = await headset.inject({
        method: 'POST',
        url,
        payload: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.statusCode, 200);
      return SessionView.parse(response.json());
    };
    const earlierNote = 'I saw the synthetic dunes before noon.';
    let earlier = await route('/v1/sessions', startRequest('Synthetic Sahara travel account.'));
    await route(`/v1/sessions/${earlier.id}/utterances`, {
      speech: { text: `Add ${earlierNote}` },
    });
    earlier = await route(`/v1/sessions/${earlier.id}/commit`, {});
    const old = test.boopy.package(earlier.committed?.packageId ?? '');
    assert.ok(old);
    let current = await route(
      '/v1/sessions',
      startRequest('Use this synthetic scene for later Korean practice.'),
    );
    const camel = current.items.find((item) => item.label === 'Camels');
    assert.ok(camel);
    current = await route(`/v1/sessions/${current.id}/utterances`, {
      speech: { text: "It's a dromedary" },
      cues: { targetItemId: camel.id },
    });
    const reject = current.items.find((item) => item.label === 'Tents');
    assert.ok(reject);
    await route(`/v1/sessions/${current.id}/actions`, { itemId: reject.id, action: 'reject' });
    current = await route(`/v1/sessions/${current.id}/commit`, {});
    const baseline = test.boopy.package(current.committed?.packageId ?? '');
    assert.ok(baseline);
    const priorCamel = evidenceRecords(old).find((record) => record.label === 'Camels');
    const corrected = evidenceRecords(baseline).find((record) => record.itemId === camel.id);
    const olderAccount = evidenceRecords(old).find((record) => record.statement === earlierNote);
    assert.ok(priorCamel && corrected && olderAccount);
    assert.equal(corrected.verification, 'corrected');
    test.boopy.supersede({ predecessor: priorCamel, successor: corrected });
    // Negative scope fixture in the same journal; never selected or exported.
    const unselected = await route('/v1/sessions', startRequest('Synthetic unselected context.'));
    const unselectedSaved = await route(`/v1/sessions/${unselected.id}/commit`, {});
    const selectedPackageIds = [old.id, baseline.id];
    const selectedPackages = [old, baseline];
    const snapshots = selectedPackages.map((pkg) => JSON.stringify(test.boopy.package(pkg.id)));
    const superseded = new Set(
      test.boopy.supersessions.map((link) => evidenceSourceId(link.predecessor)),
    );
    const eligible = selectedPackages
      .flatMap((pkg) => evidenceRecords(pkg))
      .filter(
        (record) =>
          !superseded.has(record.sourceId) &&
          (record.disposition === 'context' || record.disposition === 'intent'),
      );
    const origin = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers } }),
    );
    assert.equal(
      (await client.listTools()).tools.some((tool) => tool.name === 'recall'),
      memory && !options.memoryUnavailable,
    );
    const query = `dromedary 낙타 ${earlierNote}`;
    if (
      [options.references, options.referenceReceiptPath, options.referenceCredentials].filter(
        Boolean,
      ).length > 1
    )
      throw new Error('Choose one reference mode.');
    const preparationStarted = performance.now();
    const preparePath = `/v1/sessions/${current.id}/handoff-preparations`;
    const initiated = await headset.inject({
      method: 'POST',
      url: preparePath,
      payload: {
        requestId: 'synthetic-composed-preparation',
        packageId: baseline.id,
        ...(memory ? { memory: { packageIds: selectedPackageIds, query } } : {}),
        ...(options.referenceCredentials
          ? {
              references: {
                packageId: olderAccount.packageId,
                itemId: olderAccount.itemId,
                conceptKey: 'dune',
                referenceId: 'Q25391',
              },
            }
          : {}),
      },
    });
    assert.equal(initiated.statusCode, 202);
    let status = initiated.json() as { state: string; receipt?: HandoffPreparationReceipt };
    const deadline = performance.now() + 45000;
    while (status.state === 'preparing-local' && performance.now() < deadline) {
      await delay(10);
      const polled = await headset.inject({
        method: 'GET',
        url: `${preparePath}/synthetic-composed-preparation`,
      });
      assert.equal(polled.statusCode, 200);
      assert.equal(polled.headers['cache-control'], 'no-store');
      assert.equal(polled.body.includes(directory), false);
      assert.equal(polled.body.includes(earlierNote), false);
      status = polled.json();
    }
    assert.equal(status.state, 'prepared-local');
    assert.ok(status.receipt);
    assert.equal(status.receipt.delivery, 'not-sent');
    assert.equal(status.receipt.historicalSnapshot, true);
    assert.ok(observedExport);
    const exported = observedExport;
    const preparationLatencyMs = Math.round(performance.now() - preparationStarted);
    const operatorPath = join(directory, 'operator-prepared-export.txt');
    const operatorExport = await exportPrepared({
      packageId: baseline.id,
      requestId: 'synthetic-composed-preparation',
      dataDir: directory,
      output: operatorPath,
      port,
    });
    const verifiedBytes = await readFile(operatorPath);
    const verifiedPacket = verifiedBytes.toString('utf8');
    const operatorPacketSha256 = createHash('sha256').update(verifiedBytes).digest('hex');
    const operatorFileMode = (await stat(operatorPath)).mode & 0o777;
    assert.equal(operatorPacketSha256, status.receipt.packetSha256);
    assert.equal(operatorFileMode, 0o600);
    assert.equal(operatorExport.bytes, verifiedBytes.byteLength);
    assert.equal(operatorExport.sentToMuse, false);
    assert.ok(
      test.journal
        .all()
        .some(
          (event) =>
            event.type === 'handoff.packet-read' &&
            event.data.requestId === 'synthetic-composed-preparation' &&
            event.data.packetSha256 === operatorPacketSha256,
        ),
    );
    assert.equal(verifiedPacket, exported.artifacts.packet);
    assert.equal(status.receipt.baselineSha256, exported.baseline.sha256);
    // Explicit rehearsal retention copies only synthetic artifacts; production uses app-owned storage.
    for (const [file, contents] of [
      [exported.files.baseline, exported.artifacts.baselineText],
      [exported.files.supplement, exported.artifacts.supplementText],
      [exported.files.packet, verifiedPacket],
      [
        exported.files.manifest,
        JSON.stringify({ ...exported, artifacts: undefined, outputDirectory: undefined }, null, 2),
      ],
    ]) {
      assert.ok(file && contents);
      await writeFile(join(destination, file), contents, { mode: 0o600, flag: 'wx' });
    }
    if (
      options.referenceCredentials &&
      !options.referenceLookup &&
      exported.references.status !== 'available'
    )
      throw new Error('Independent reference unavailable.');
    const baselineText = exported.artifacts.baselineText;
    const delivered = await fetch(`${origin}/v1/context/${baseline.id}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(delivered.status, 200);
    assert.equal(baselineText, ((await delivered.json()) as ContextPackage).text);
    assert.equal((await stat(join(destination, exported.files.baseline))).mode & 0o777, 0o600);
    assert.equal(baselineText.includes(earlierNote), false);
    const fetched = await client.callTool({ name: 'fetch', arguments: { id: baseline.id } });
    const fetchedText = fetched.content.find((block) => block.type === 'text');
    assert.ok(fetchedText?.type === 'text');
    assert.equal(JSON.parse(fetchedText.text).metadata.package.id, baseline.id);
    const response = await fetch(`${origin}/v1/recall`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ packageIds: selectedPackageIds, query, limit: 20 }),
      signal: AbortSignal.timeout(5000),
    });
    let recall: RecallResult | null = null;
    if (memory && !options.memoryUnavailable) {
      assert.equal(response.status, 200);
      recall = (await response.json()) as RecallResult;
      assert.equal(recall.engine, 'hmem-subset');
      assert.ok(recall.results.some((hit) => hit.evidence.sourceId === corrected.sourceId));
      assert.ok(recall.results.some((hit) => hit.evidence.sourceId === olderAccount.sourceId));
      assert.ok(!recall.results.some((hit) => hit.evidence.sourceId === priorCamel.sourceId));
      const result = await client.callTool({
        name: 'recall',
        arguments: { packageIds: selectedPackageIds, query, limit: 20 },
      });
      const block = result.content.find((part) => part.type === 'text');
      assert.ok(block?.type === 'text');
      assert.deepEqual(JSON.parse(block.text), recall);
    } else {
      assert.equal(response.status, 404);
      await response.body?.cancel();
    }
    const references = options.referenceCredentials
      ? {
          mode: 'zetaris-reference-lookup' as const,
          rows: exported.artifacts.supplement.references.rows.map((row) => row.reference),
        }
      : options.referenceReceiptPath
        ? await providedSyntheticReferences(options.referenceReceiptPath, eligible)
        : options.references
          ? await options.references({
              packageIds: selectedPackageIds,
              baselinePackageId: baseline.id,
              evidence: structuredClone(eligible),
            })
          : null;
    if (
      references &&
      (![
        'synthetic-contract',
        'provided-synthetic-zetaris-receipt',
        'zetaris-reference-lookup',
      ].includes(references.mode) ||
        references.rows.length > 20)
    )
      throw new Error('Invalid synthetic reference result.');
    const bySource = new Map(eligible.map((record) => [record.sourceId, record]));
    const referenceRows = (references?.rows ?? []).map((input) => {
      const reference = ReferenceRow.parse(input);
      const evidence = bySource.get(reference.sourceId);
      if (!evidence) throw new Error('Unselected, superseded or excluded reference source.');
      return { reference, evidence };
    });
    const assembledSupplement: SelectedSupplement = {
      synthetic: true,
      baselinePackageId: baseline.id,
      selectedPackageIds:
        options.references || options.referenceReceiptPath
          ? selectedPackageIds
          : exported.artifacts.supplement.selectedPackageIds,
      memory: {
        mode: memory ? 'hmem-subset' : 'disabled',
        hits: recall?.results ?? [],
        constraints: recall?.constraints ?? [],
        openQuestions: recall?.openQuestions ?? [],
        ...(recall?.semantic ? { semantic: recall.semantic } : {}),
      },
      references: { mode: references?.mode ?? 'disabled', rows: referenceRows },
    };
    const supplement =
      options.references || options.referenceReceiptPath
        ? assembledSupplement
        : exported.artifacts.supplement;
    const supplementText = renderSelectedSupplement(supplement);
    if (options.references || options.referenceReceiptPath) {
      await writeFile(
        join(
          destination,
          options.referenceReceiptPath
            ? 'provided-reference-supplement.txt'
            : 'schema-reference-supplement.txt',
        ),
        supplementText,
        { mode: 0o600, flag: 'wx' },
      );
    } else assert.equal(supplementText, exported.artifacts.supplementText);
    assert.equal((await stat(join(destination, 'selected-supplement.txt'))).mode & 0o777, 0o600);
    assert.deepEqual(
      selectedPackages.map((pkg) => JSON.stringify(test.boopy.package(pkg.id))),
      snapshots,
    );
    assert.ok(
      test.boopy.disclosures.some(
        (entry) => entry.agent === 'local-manual-export' && entry.packageId === baseline.id,
      ),
    );
    const all = [
      ...supplement.memory.hits.map((hit) => hit.evidence),
      ...supplement.memory.constraints,
      ...supplement.memory.openQuestions,
      ...referenceRows.map((row) => row.evidence),
    ];
    assert.ok(
      all.every(
        (record) =>
          selectedPackageIds.includes(record.packageId) &&
          record.packageId !== unselectedSaved.committed?.packageId,
      ),
    );
    return {
      localChecksPassed: true,
      synthetic: true,
      selectedPackageIds,
      baselinePackageId: baseline.id,
      memory: memory
        ? options.memoryUnavailable
          ? 'unavailable'
          : 'real-hmem-subset'
        : 'disabled',
      preparationApi: 'headset-post-and-poll',
      operatorExportVerified: true,
      operatorExportApi: 'authenticated-loopback-local-handoff',
      operatorPacketSha256,
      operatorPacketBytes: verifiedBytes.byteLength,
      operatorFileMode: operatorFileMode.toString(8),
      preparationState: status.receipt.state,
      preparationLatencyMs,
      semantic: recall?.semantic ?? { status: 'disabled' },
      moduleStates: {
        memory: status.receipt.memory.status,
        references: status.receipt.references.status,
      },
      recalledSources: recall?.results.length ?? 0,
      additionalAuthoredAccountRecalled:
        recall?.results.some((hit) => hit.evidence.sourceId === olderAccount.sourceId) ?? false,
      references: references?.mode ?? 'disabled',
      referenceAssociations: referenceRows.length,
      baselineExportExact: true,
      immutableSnapshots: true,
      privateArtifacts: true,
      artifactsRetained: !!options.artifactDirectory,
      museDelivery: 'manual-not-attempted',
      zetarisRuntime: options.referenceLookup
        ? 'synthetic-reference-adapter'
        : options.referenceCredentials
          ? 'fresh-independent-reference-query'
          : options.referenceReceiptPath
            ? 'provided-historical-synthetic-receipt'
            : 'not-tested',
      artifacts: { baselineText, supplementText, supplement },
    };
  } finally {
    connector.server.closeAllConnections();
    await Promise.allSettled([client.close(), connector.close(), headset.close()]);
    test.journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  let worker: NvidiaEmbeddingWorker | undefined;
  try {
    const { values } = parseArgs({
      options: {
        memory: { type: 'string', default: 'on' },
        'output-dir': { type: 'string' },
        'nvidia-python': { type: 'string' },
        'nvidia-model': { type: 'string' },
        'nvidia-device': { type: 'string' },
        'reference-receipt': { type: 'string' },
        'reference-credentials': { type: 'string' },
      },
    });
    if (!['on', 'off'].includes(values.memory ?? '')) throw new Error('Choose on or off.');
    if (values['nvidia-python'] || values['nvidia-model'] || values['nvidia-device']) {
      if (
        values.memory !== 'on' ||
        !values['nvidia-python'] ||
        !values['nvidia-model'] ||
        !['cpu', 'mps'].includes(values['nvidia-device'] ?? '')
      )
        throw new Error('Explicit local NVIDIA paths/device and memory on required.');
      worker = new NvidiaEmbeddingWorker({
        pythonPath: values['nvidia-python'],
        modelDirectory: values['nvidia-model'],
        device: values['nvidia-device'] as 'cpu' | 'mps',
      });
      await worker.rank({
        query: 'Synthetic warmup',
        candidates: [{ sourceId: 'synthetic-warmup', text: 'Synthetic warmup only.' }],
      });
    }
    const { artifacts: _artifacts, ...summary } = await hackathonRehearsal({
      memory: values.memory === 'on',
      semanticRanker: worker,
      ...(values['reference-credentials']
        ? { referenceCredentials: values['reference-credentials'] }
        : {}),
      ...(values['reference-receipt'] ? { referenceReceiptPath: values['reference-receipt'] } : {}),
      ...(values['output-dir'] ? { artifactDirectory: values['output-dir'] } : {}),
    });
    console.log(JSON.stringify(summary, null, 2));
  } catch {
    console.error(
      'Synthetic composed rehearsal failed. No Muse delivery or Zetaris runtime success is claimed.',
    );
    process.exitCode = 1;
  } finally {
    worker?.close();
  }
}
