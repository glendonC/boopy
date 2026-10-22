import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { evidenceRecords } from '../evidence-contract.ts';
import { connectorApp } from '../http/connector.ts';
import { ZetarisReferenceAssociation } from '../references/zetaris.ts';
import { startRequest, testBoopy } from '../testing.ts';
import { exportHandoff } from './export-handoff.ts';

async function setup(
  memory: boolean,
  tamper?: 'scope' | 'oversize',
  semantic?: 'available' | 'unavailable' | 'invalid',
) {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-modular-handoff-test-'));
  const outputDirectory = join(directory, 'output');
  await mkdir(outputDirectory, { mode: 0o700 });
  const token = 'synthetic-modular-handoff-token';
  await writeFile(join(directory, 'connector-token'), token, { mode: 0o600 });
  const test = testBoopy();
  const earlier = await test.boopy.start(startRequest('Synthetic earlier scene.'));
  await test.boopy.utter(earlier.id, { speech: { text: 'Add Dunes before noon.' } });
  const oldId = test.boopy.commit(earlier.id).committed?.packageId;
  assert.ok(oldId);
  const current = await test.boopy.start(startRequest('Synthetic current scene.'));
  const packageId = test.boopy.commit(current.id).committed?.packageId;
  assert.ok(packageId);
  const app = connectorApp(test.boopy, {
    token,
    baseUrl: 'http://127.0.0.1',
    logger: false,
    memory,
    ...(semantic
      ? {
          semanticRanker: {
            async rank(request: { candidates: { sourceId: string }[] }) {
              if (semantic === 'unavailable') throw new Error('Synthetic ranker failure');
              return {
                model: 'nvidia/nemotron-3-embed-1b',
                revision: 'c0c9fea93ea424587517f2c59e20db9f1d6bf615',
                candidates: request.candidates.map((candidate) => ({
                  sourceId: candidate.sourceId,
                  score: 0.9,
                })),
              };
            },
          },
        }
      : {}),
  });
  if (semantic === 'invalid')
    app.addHook('preSerialization', async (request, _reply, payload) =>
      request.raw.url === '/v1/recall'
        ? {
            ...(payload as object),
            semantic: {
              status: 'available',
              provider: 'nvidia',
              model: 'invented',
              revision: 'unknown',
            },
          }
        : payload,
    );
  if (tamper)
    app.addHook('preSerialization', async (request, _reply, payload) => {
      if (request.raw.url !== '/v1/recall') return payload;
      if (tamper === 'oversize') return { oversized: 'x'.repeat(2 * 1024 * 1024 + 1) };
      const changed = structuredClone(payload) as {
        results: { evidence: { packageId: string; itemId: string; sourceId: string } }[];
      };
      assert.ok(changed.results[0]);
      changed.results[0].evidence.packageId = 'ctx_unselected_response';
      changed.results[0].evidence.sourceId = `ctx_unselected_response:${encodeURIComponent(changed.results[0].evidence.itemId)}`;
      return changed;
    });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    ...test,
    directory,
    outputDirectory,
    token,
    oldId,
    packageId,
    app,
    options: {
      dataDir: directory,
      outputDirectory,
      packageId,
      port: (app.server.address() as AddressInfo).port,
    },
    close: async () => {
      app.server.closeAllConnections();
      await app.close();
      test.journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('production modular export preserves exact baseline and selected real recall as a separate attributed packet', async () => {
  const test = await setup(true);
  try {
    const before = JSON.stringify(test.boopy.package(test.packageId));
    const result = await exportHandoff({
      ...test.options,
      memory: { packageIds: [test.oldId], query: 'Dunes before noon' },
    });
    assert.equal(result.memory.status, 'available');
    assert.ok(result.memory.returnedSources > 0);
    assert.deepEqual(result.memory.selectedPackageIds, [test.oldId]);
    assert.equal(result.references.status, 'disabled');
    assert.deepEqual(result.delivery, {
      transport: 'manual',
      sentToMuse: false,
      account: 'not-checked',
    });
    const baseline = await readFile(join(test.outputDirectory, result.files.baseline), 'utf8');
    assert.equal(baseline, test.boopy.package(test.packageId)?.text);
    assert.equal(baseline.includes('Dunes before noon'), false);
    const supplement = await readFile(join(test.outputDirectory, result.files.supplement), 'utf8');
    assert.ok(supplement.includes('Dunes before noon'));
    assert.ok(supplement.includes('"modelConfidence":null'));
    assert.ok(supplement.includes('"verification":"authored"'));
    assert.ok(supplement.includes('"retrievalConfidence":1'));
    assert.ok(supplement.includes('"relevance":'));
    assert.equal(supplement.includes('FICTIONAL'), false);
    assert.equal(JSON.stringify(test.boopy.package(test.packageId)), before);
    assert.ok(
      test.boopy.disclosures.some(
        (entry) => entry.agent === 'local-manual-export' && entry.packageId === test.packageId,
      ),
    );
    assert.ok(
      test.boopy.disclosures.some(
        (entry) => entry.agent === 'local-modular-handoff' && entry.packageId === test.oldId,
      ),
    );
    const manifestText = await readFile(join(test.outputDirectory, result.files.manifest), 'utf8');
    assert.equal(manifestText.includes('Dunes before noon'), false);
    assert.equal(JSON.stringify(result).includes(test.token), false);
  } finally {
    await test.close();
  }
});

it('explicitly disabled modules preserve core export with no recall disclosures', async () => {
  const test = await setup(false);
  try {
    const result = await exportHandoff(test.options);
    assert.equal(result.memory.status, 'disabled');
    assert.equal(result.references.status, 'disabled');
    assert.equal(
      test.boopy.disclosures.some((entry) => entry.tool === 'recall'),
      false,
    );
    assert.equal(
      await readFile(join(test.outputDirectory, result.files.baseline), 'utf8'),
      test.boopy.package(test.packageId)?.text,
    );
  } finally {
    await test.close();
  }
});

it('optional recall unavailability keeps the completed baseline and marks unavailable without invented results', async () => {
  const test = await setup(false);
  try {
    const result = await exportHandoff({
      ...test.options,
      memory: { packageIds: [test.oldId], query: 'Dunes before noon' },
    });
    assert.equal(result.memory.status, 'unavailable');
    assert.equal(result.memory.returnedSources, 0);
    const baseline = await readFile(join(test.outputDirectory, result.files.baseline), 'utf8');
    assert.equal(baseline, test.boopy.package(test.packageId)?.text);
    const supplement = await readFile(join(test.outputDirectory, result.files.supplement), 'utf8');
    assert.ok(supplement.includes('status: unavailable'));
    assert.equal(supplement.includes('Dunes before noon'), false);
    assert.equal(
      test.boopy.disclosures.some((entry) => entry.tool === 'recall'),
      false,
    );
  } finally {
    await test.close();
  }
});

it('unknown selected package is an unavailable optional module and cannot lose or expand the baseline', async () => {
  const test = await setup(true);
  try {
    const result = await exportHandoff({
      ...test.options,
      memory: { packageIds: ['ctx_not_selected'], query: 'Dunes' },
    });
    assert.equal(result.memory.status, 'unavailable');
    assert.equal(
      await readFile(join(test.outputDirectory, result.files.baseline), 'utf8'),
      test.boopy.package(test.packageId)?.text,
    );
    assert.equal(
      test.boopy.disclosures.some((entry) => entry.packageId === test.oldId),
      false,
    );
  } finally {
    await test.close();
  }
});

it('existing output files fail before a disclosure or overwrite', async () => {
  const test = await setup(true);
  try {
    await writeFile(join(test.outputDirectory, 'selected-supplement.txt'), 'synthetic sentinel', {
      mode: 0o600,
    });
    await assert.rejects(exportHandoff(test.options));
    assert.equal(test.boopy.disclosures.length, 0);
    assert.equal(
      await readFile(join(test.outputDirectory, 'selected-supplement.txt'), 'utf8'),
      'synthetic sentinel',
    );
  } finally {
    await test.close();
  }
});

for (const tamper of ['scope', 'oversize'] as const) {
  it(`optional ${tamper} response fails closed while preserving the baseline`, async () => {
    const test = await setup(true, tamper);
    try {
      const result = await exportHandoff({
        ...test.options,
        memory: { packageIds: [test.oldId], query: 'Dunes before noon' },
      });
      assert.equal(result.memory.status, 'unavailable');
      assert.equal(result.memory.returnedSources, 0);
      assert.equal(
        await readFile(join(test.outputDirectory, result.files.baseline), 'utf8'),
        test.boopy.package(test.packageId)?.text,
      );
      const supplement = await readFile(
        join(test.outputDirectory, result.files.supplement),
        'utf8',
      );
      assert.equal(supplement.includes('ctx_unselected_response'), false);
      assert.equal(supplement.includes('Dunes before noon'), false);
    } finally {
      await test.close();
    }
  });
}

const independentReference = {
  mode: 'zetaris-runtime' as const,
  operation: 'reference-lookup' as const,
  rows: [
    {
      referenceSourceId: 'wikidata:Q25391' as const,
      referenceId: 'Q25391' as const,
      koreanTerm: '사구',
      englishGloss: 'dune',
      referenceVersion: '2546278779',
      updatedAt: '1970-01-01T16:49:42Z',
      referenceStatus: 'external-unreviewed' as const,
      referenceUrl: 'https://www.wikidata.org/wiki/Q25391' as const,
      license: 'CC0-1.0' as const,
    },
  ],
};

it('fresh reference adapter receives only the explicit QID and credentials, with local full-record binding', async () => {
  const test = await setup(true);
  try {
    const source = evidenceRecords(test.boopy.package(test.oldId)).find(
      (record) => record.statement === 'Dunes before noon.',
    );
    assert.ok(source);
    const before = JSON.stringify(test.boopy.package(test.oldId));
    let calls = 0;
    const result = await exportHandoff(
      {
        ...test.options,
        synthetic: true,
        memory: { packageIds: [test.oldId], query: 'Dunes before noon' },
        references: {
          packageId: source.packageId,
          itemId: source.itemId,
          conceptKey: 'dune',
          referenceId: 'Q25391',
          credentialFile: '/synthetic/reference-reader.credentials',
        },
      },
      {
        lookupReference: async (options) => {
          calls++;
          assert.deepEqual(Object.keys(options).sort(), [
            'credentialFile',
            'referenceId',
            'signal',
          ]);
          assert.equal(options.referenceId, 'Q25391');
          assert.ok(options.signal instanceof AbortSignal);
          return independentReference;
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.references.status, 'available');
    assert.equal(result.references.mode, 'zetaris-reference-lookup');
    assert.equal(result.references.returnedAssociations, 1);
    const association = result.artifacts.supplement.references.rows[0];
    assert.ok(association);
    assert.deepEqual(association.evidence, source);
    assert.equal(association.evidence.modelConfidence, null);
    assert.equal(association.evidence.verification, 'authored');
    assert.equal(association.reference.revisionId, null);
    assert.equal(association.reference.referenceStatus, 'external-unreviewed');
    assert.equal(association.reference.sourceRecordSha256?.length, 64);
    assert.equal(JSON.stringify(test.boopy.package(test.oldId)), before);
    assert.equal(result.artifacts.baselineText.includes('사구'), false);
    assert.ok(result.artifacts.supplementText.includes('사구'));
    assert.equal(
      JSON.stringify({ ...result, artifacts: undefined }).includes('reference-reader.credentials'),
      false,
    );
  } finally {
    await test.close();
  }
});

it('reference failure is sanitized and cannot lose the baseline or fabricate a connection', async () => {
  const test = await setup(false);
  try {
    const source = evidenceRecords(test.boopy.package(test.oldId)).find(
      (record) => record.statement === 'Dunes before noon.',
    );
    assert.ok(source);
    const result = await exportHandoff(
      {
        ...test.options,
        references: {
          packageId: source.packageId,
          itemId: source.itemId,
          conceptKey: 'dune',
          referenceId: 'Q25391',
          credentialFile: '/synthetic/private.credentials',
        },
      },
      {
        lookupReference: async () => {
          throw new Error('private provider secret must not be disclosed');
        },
      },
    );
    assert.equal(result.references.status, 'unavailable');
    assert.equal(result.references.returnedAssociations, 0);
    assert.equal(result.artifacts.baselineText, test.boopy.package(test.packageId)?.text);
    assert.equal(JSON.stringify(result).includes('private provider secret'), false);
    assert.equal(result.delivery.sentToMuse, false);
  } finally {
    await test.close();
  }
});

it('superseded context is rejected before an independent-reference lookup', async () => {
  const test = await setup(true);
  try {
    const old = evidenceRecords(test.boopy.package(test.oldId)).find(
      (record) => record.label === 'Camels',
    );
    const current = evidenceRecords(test.boopy.package(test.packageId)).find(
      (record) => record.label === 'Camels',
    );
    assert.ok(old && current);
    test.boopy.supersede({ predecessor: old, successor: current });
    let calls = 0;
    const result = await exportHandoff(
      {
        ...test.options,
        references: {
          packageId: old.packageId,
          itemId: old.itemId,
          conceptKey: 'dune',
          referenceId: 'Q25391',
          credentialFile: '/synthetic/unused.credentials',
        },
      },
      {
        lookupReference: async () => {
          calls++;
          return independentReference;
        },
      },
    );
    assert.equal(calls, 0);
    assert.equal(result.references.status, 'unavailable');
    assert.equal(result.artifacts.supplement.references.rows.length, 0);
    assert.equal(result.artifacts.baselineText, test.boopy.package(test.packageId)?.text);
  } finally {
    await test.close();
  }
});

it('accepts the verified public reference catalog only through exact explicit concept-ID pairs', async () => {
  for (const association of [
    { conceptKey: 'desert', referenceId: 'Q8514', koreanTerm: '사막' },
    { conceptKey: 'dromedary', referenceId: 'Q71516', koreanTerm: '단봉낙타' },
  ] as const) {
    const test = await setup(false);
    try {
      const record = evidenceRecords(test.boopy.package(test.oldId)).find(
        (item) => item.disposition === 'context',
      );
      assert.ok(record);
      let called = false;
      const result = await exportHandoff(
        {
          ...test.options,
          references: {
            packageId: test.oldId,
            itemId: record.itemId,
            ...ZetarisReferenceAssociation.parse(association),
            credentialFile: '/synthetic/reference-reader.credentials',
          },
        },
        {
          lookupReference: async (options) => {
            called = true;
            assert.equal(options.referenceId, association.referenceId);
            const reference = independentReference.rows[0];
            assert.ok(reference);
            return {
              ...independentReference,
              rows: [
                {
                  ...reference,
                  referenceId: association.referenceId,
                  referenceSourceId: `wikidata:${association.referenceId}`,
                  referenceUrl: `https://www.wikidata.org/wiki/${association.referenceId}`,
                  koreanTerm: association.koreanTerm,
                },
              ],
            };
          },
        },
      );
      assert.equal(called, true);
      assert.equal(result.references.status, 'available');
      assert.equal(
        result.artifacts.supplement.references.rows[0]?.reference.referenceId,
        association.referenceId,
      );
    } finally {
      await test.close();
    }
  }
});

it('rejects mismatched catalog pairs before any export or lookup', async () => {
  const test = await setup(false);
  try {
    const record = evidenceRecords(test.boopy.package(test.oldId))[0];
    assert.ok(record);
    const before = test.journal.all().length;
    await assert.rejects(
      exportHandoff({
        ...test.options,
        references: {
          packageId: test.oldId,
          itemId: record.itemId,
          conceptKey: 'dune',
          referenceId: 'Q8514',
          credentialFile: '/synthetic/reference-reader.credentials',
        },
      } as unknown as Parameters<typeof exportHandoff>[0]),
    );
    assert.equal(test.journal.all().length, before);
    await assert.rejects(readFile(join(test.outputDirectory, 'baseline-context.txt')));
  } finally {
    await test.close();
  }
});

it('semantic available and unavailable metadata survive packet and manifest without verification upgrades', async () => {
  for (const status of ['available', 'unavailable'] as const) {
    const fixture = await setup(true, undefined, status);
    try {
      const result = await exportHandoff({
        ...fixture.options,
        memory: { packageIds: [fixture.oldId, fixture.packageId], query: 'Dunes before noon' },
      });
      assert.equal(result.memory.semantic?.status, status);
      assert.equal(result.artifacts.supplement.memory.semantic?.status, status);
      assert.match(result.artifacts.packet, /Semantic ranking \(not verification\)/);
      const manifest = JSON.parse(
        await readFile(join(fixture.outputDirectory, result.files.manifest), 'utf8'),
      );
      assert.deepEqual(manifest.memory.semantic, result.memory.semantic);
      assert.equal(manifest.delivery.sentToMuse, false);
      for (const hit of result.artifacts.supplement.memory.hits) {
        const original = evidenceRecords(
          fixture.boopy.package(hit.evidence.packageId) as NonNullable<
            ReturnType<typeof fixture.boopy.package>
          >,
        ).find((record) => record.sourceId === hit.evidence.sourceId);
        assert.deepEqual(hit.evidence, original);
      }
    } finally {
      await fixture.close();
    }
  }
});
it('unrecognized available semantic model fails the optional module without losing baseline', async () => {
  const fixture = await setup(true, undefined, 'invalid');
  try {
    const result = await exportHandoff({
      ...fixture.options,
      memory: { packageIds: [fixture.oldId], query: 'Dunes' },
    });
    assert.equal(result.memory.status, 'unavailable');
    assert.equal(result.memory.semantic, undefined);
    assert.equal(result.baseline.status, 'available');
  } finally {
    await fixture.close();
  }
});

it('correction during reference lookup refuses stale association while preserving baseline', async () => {
  const fixture = await setup(true);
  try {
    const old = fixture.boopy.package(fixture.oldId);
    const current = fixture.boopy.package(fixture.packageId);
    assert.ok(old && current);
    const predecessor = evidenceRecords(old).find((record) => record.disposition === 'context');
    const successor = evidenceRecords(current).find((record) => record.disposition === 'context');
    assert.ok(predecessor && successor);
    const result = await exportHandoff(
      {
        ...fixture.options,
        references: {
          packageId: fixture.oldId,
          itemId: predecessor.itemId,
          conceptKey: 'dune',
          referenceId: 'Q25391',
          credentialFile: '/synthetic/credentials',
        },
      },
      {
        lookupReference: async () => {
          fixture.boopy.supersede({ predecessor, successor });
          return independentReference;
        },
      },
    );
    assert.equal(result.references.status, 'unavailable');
    assert.deepEqual(result.artifacts.supplement.references.rows, []);
    assert.equal(result.baseline.status, 'available');
  } finally {
    await fixture.close();
  }
});

it('rechecks separate recalled memory after a gated reference lookup without losing baseline', async () => {
  const fixture = await setup(true);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const old = fixture.boopy.package(fixture.oldId);
    const current = fixture.boopy.package(fixture.packageId);
    assert.ok(old && current);
    const predecessor = evidenceRecords(old).find(
      (record) => record.statement === 'Dunes before noon.',
    );
    const successor = evidenceRecords(current).find((record) => record.disposition === 'context');
    assert.ok(predecessor && successor);
    const pending = exportHandoff(
      {
        ...fixture.options,
        memory: { packageIds: [fixture.oldId], query: 'Dunes before noon' },
        references: {
          packageId: fixture.packageId,
          itemId: successor.itemId,
          conceptKey: 'dune',
          referenceId: 'Q25391',
          credentialFile: '/synthetic/credentials',
        },
      },
      {
        lookupReference: async () => {
          entered();
          await gate;
          return independentReference;
        },
      },
    );
    await ready;
    fixture.boopy.supersede({ predecessor, successor });
    release();
    const result = await pending;
    assert.equal(result.memory.status, 'unavailable');
    assert.equal(result.memory.returnedSources, 0);
    assert.equal(result.memory.semantic, undefined);
    assert.deepEqual(result.artifacts.supplement.memory.hits, []);
    assert.equal(result.artifacts.supplementText.includes('Dunes before noon'), false);
    assert.equal(result.references.status, 'available');
    assert.equal(result.baseline.status, 'available');
    assert.equal(result.artifacts.baselineText, current.text);
    assert.equal(result.delivery.sentToMuse, false);
  } finally {
    release();
    await fixture.close();
  }
});

it('writes packet and supplement headings without em dashes in both modes', async () => {
  const test = await setup(false);
  const emDash = String.fromCharCode(0x2014);
  try {
    for (const synthetic of [false, true]) {
      const output = join(test.directory, `headings-${synthetic}`);
      await mkdir(output, { mode: 0o700 });
      const result = await exportHandoff({ ...test.options, outputDirectory: output, synthetic });
      const packet = result.artifacts.packet;
      const supplement = await readFile(join(output, result.files.supplement), 'utf8');
      assert.equal(
        packet.split('\n')[0],
        synthetic
          ? 'FICTIONAL SYNTHETIC BOOPY REHEARSAL. NOT PERSONAL HISTORY.'
          : 'BOOPY CONTEXT: MANUAL ASSISTANT HANDOFF.',
      );
      for (const text of [
        packet,
        supplement,
        await readFile(join(output, result.files.packet), 'utf8'),
      ])
        assert.equal(text.includes(emDash), false);
    }
  } finally {
    await test.close();
  }
});
