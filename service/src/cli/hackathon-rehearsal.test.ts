import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import {
  hackathonRehearsal,
  renderSelectedSupplement,
  type SyntheticReferenceProvider,
} from './hackathon-rehearsal.ts';

const syntheticReference: SyntheticReferenceProvider = async (selection) => {
  const record = selection.evidence.find(
    (item) => item.statement === 'I saw the synthetic dunes before noon.',
  );
  assert.ok(record);
  assert.equal(record.verification, 'authored');
  assert.equal(record.modelConfidence, null);
  assert.equal(record.observationId, null);
  assert.equal(
    selection.evidence.some((item) => item.disposition === 'rejected'),
    false,
  );
  assert.equal(
    selection.evidence.some((item) => item.label === 'Camels'),
    false,
  );
  return {
    mode: 'synthetic-contract',
    rows: [
      {
        sourceId: record.sourceId,
        packageId: record.packageId,
        itemId: record.itemId,
        revisionId: null,
        referenceId: 'synthetic-dune-term',
        referenceSource: 'synthetic-fixture-table',
        referenceVersion: 'synthetic-v1',
        updatedAt: '1970-01-01T00:00:00Z',
        referenceStatus: 'synthetic-unreviewed',
        referenceUrl: 'https://example.invalid/synthetic-reference',
        koreanTerm: '합성 예시',
      },
    ],
  };
};

it('composes one selected source chain through real routes, export, H-MEM and separate attributed reference supplement', async () => {
  const result = await hackathonRehearsal({ references: syntheticReference });
  assert.equal(result.localChecksPassed, true);
  assert.equal(result.operatorExportVerified, true);
  assert.equal(result.operatorExportApi, 'authenticated-loopback-local-handoff');
  assert.equal(result.operatorFileMode, '600');
  assert.match(result.operatorPacketSha256, /^[a-f0-9]{64}$/);
  assert.ok(result.operatorPacketBytes > 0);
  assert.equal(result.baselineExportExact, true);
  assert.equal(result.additionalAuthoredAccountRecalled, true);
  assert.equal(result.referenceAssociations, 1);
  assert.equal(result.museDelivery, 'manual-not-attempted');
  assert.equal(result.zetarisRuntime, 'not-tested');
  const { baselineText, supplementText, supplement } = result.artifacts;
  assert.equal(baselineText.includes('I saw the synthetic dunes before noon.'), false);
  assert.ok(supplementText.includes('I saw the synthetic dunes before noon.'));
  assert.ok(supplementText.includes('Nothing has been sent to Muse'));
  assert.ok(supplementText.includes('Retrieval scores measure ranking, not truth'));
  const association = supplement.references.rows[0];
  assert.ok(association);
  const recalled = supplement.memory.hits.find(
    (hit) => hit.evidence.sourceId === association.evidence.sourceId,
  );
  assert.deepEqual(recalled?.evidence, association.evidence);
  assert.equal(association.evidence.modelConfidence, null);
  assert.equal(association.evidence.verification, 'authored');
  assert.equal(association.reference.revisionId, null);
  assert.ok(supplement.memory.hits.some((hit) => hit.evidence.verification === 'corrected'));
  assert.ok(supplement.memory.constraints.some((record) => record.disposition === 'rejected'));
  assert.ok(supplement.memory.openQuestions.length > 0);
  assert.equal(
    supplement.memory.hits.some((hit) => hit.evidence.disposition === 'rejected'),
    false,
  );
  assert.ok(
    supplement.memory.hits.every(
      (hit) => Number.isFinite(hit.relevance) && hit.retrievalConfidence === 1,
    ),
  );
  assert.ok(result.selectedPackageIds.every((id) => supplementText.includes(id)));
});

it('disabling all optional modules preserves exact baseline export and core readback', async () => {
  const enabled = await hackathonRehearsal();
  const disabled = await hackathonRehearsal({ memory: false });
  assert.equal(disabled.localChecksPassed, true);
  assert.equal(disabled.recalledSources, 0);
  assert.equal(disabled.referenceAssociations, 0);
  assert.equal(disabled.artifacts.baselineText, enabled.artifacts.baselineText);
  assert.equal(disabled.artifacts.supplement.memory.mode, 'disabled');
  assert.equal(disabled.artifacts.supplement.references.mode, 'disabled');
  assert.equal(
    disabled.artifacts.supplementText.includes('I saw the synthetic dunes before noon.'),
    false,
  );
});

it('rejects an unselected reference association without changing the completed private baseline export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-composed-output-test-'));
  try {
    await assert.rejects(
      hackathonRehearsal({
        artifactDirectory: directory,
        references: async (selection) => {
          const valid = await syntheticReference(selection);
          const row = valid.rows[0];
          assert.ok(row);
          return { ...valid, rows: [{ ...row, sourceId: 'ctx_unselected:item_unselected' }] };
        },
      }),
    );
    assert.equal((await stat(join(directory, 'baseline-context.txt'))).mode & 0o777, 0o600);
    assert.ok(
      (await readFile(join(directory, 'baseline-context.txt'), 'utf8')).includes(
        'Boopy package ID: ctx_27.',
      ),
    );
    assert.ok(
      (await readFile(join(directory, 'selected-supplement.txt'), 'utf8')).includes(
        'Reference mode: disabled',
      ),
    );
    await assert.rejects(stat(join(directory, 'schema-reference-supplement.txt')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('retains only explicitly requested private artifacts and refuses to overwrite them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boopy-composed-retained-test-'));
  try {
    const result = await hackathonRehearsal({ memory: false, artifactDirectory: directory });
    assert.equal(result.artifactsRetained, true);
    assert.equal(
      await readFile(join(directory, 'baseline-context.txt'), 'utf8'),
      result.artifacts.baselineText,
    );
    assert.equal(
      await readFile(join(directory, 'selected-supplement.txt'), 'utf8'),
      result.artifacts.supplementText,
    );
    assert.equal((await stat(join(directory, 'selected-supplement.txt'))).mode & 0o777, 0o600);
    const packetBytes = await readFile(join(directory, 'manual-handoff-packet.txt'));
    assert.equal(
      createHash('sha256').update(packetBytes).digest('hex'),
      result.operatorPacketSha256,
    );
    assert.equal(packetBytes.byteLength, result.operatorPacketBytes);
    await assert.rejects(hackathonRehearsal({ artifactDirectory: directory }));
    assert.equal(
      await readFile(join(directory, 'baseline-context.txt'), 'utf8'),
      result.artifacts.baselineText,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('supplement rendering rejects source mismatches, unselected packages and nonfinite ranking scores', async () => {
  const result = await hackathonRehearsal({ references: syntheticReference });
  const original = result.artifacts.supplement;
  const outside = structuredClone(original);
  outside.selectedPackageIds = [outside.baselinePackageId];
  assert.throws(() => renderSelectedSupplement(outside));
  const mismatched = structuredClone(original);
  assert.ok(mismatched.references.rows[0]);
  mismatched.references.rows[0].reference.itemId = 'another-item';
  assert.throws(() => renderSelectedSupplement(mismatched));
  const invalidScore = structuredClone(original);
  assert.ok(invalidScore.memory.hits[0]);
  invalidScore.memory.hits[0].relevance = Number.NaN;
  assert.throws(() => renderSelectedSupplement(invalidScore));
  const disabled = structuredClone(original);
  disabled.memory.mode = 'disabled';
  assert.throws(() => renderSelectedSupplement(disabled));
  assert.equal(renderSelectedSupplement(original), result.artifacts.supplementText);
});

it('prepares all selected modules through the actual headset job API with separately bound synthetic reference attribution', async () => {
  let lookupKeys: string[] = [];
  const result = await hackathonRehearsal({
    referenceCredentials: '/synthetic/reference-reader.credentials',
    referenceLookup: async (options) => {
      lookupKeys = Object.keys(options).sort();
      return {
        mode: 'zetaris-runtime',
        operation: 'reference-lookup',
        rows: [
          {
            referenceSourceId: 'wikidata:Q25391',
            referenceId: 'Q25391',
            koreanTerm: '사구',
            englishGloss: 'dune',
            referenceVersion: '2546278779',
            updatedAt: '1970-01-01T16:49:42Z',
            referenceStatus: 'external-unreviewed',
            referenceUrl: 'https://www.wikidata.org/wiki/Q25391',
            license: 'CC0-1.0',
          },
        ],
      };
    },
  });
  assert.deepEqual(lookupKeys, ['credentialFile', 'referenceId', 'signal']);
  assert.equal(result.preparationApi, 'headset-post-and-poll');
  assert.equal(result.preparationState, 'prepared-local');
  assert.deepEqual(result.moduleStates, { memory: 'available', references: 'available' });
  assert.equal(result.zetarisRuntime, 'synthetic-reference-adapter');
  assert.equal(result.museDelivery, 'manual-not-attempted');
  assert.equal(result.referenceAssociations, 1);
  assert.equal(result.additionalAuthoredAccountRecalled, true);
  assert.ok(result.preparationLatencyMs >= 0 && result.preparationLatencyMs < 45000);
});

it('actual headset preparation preserves exact baseline while both optional providers are unavailable', async () => {
  const result = await hackathonRehearsal({
    memoryUnavailable: true,
    referenceCredentials: '/synthetic/reference-reader.credentials',
    referenceLookup: async () => {
      throw new Error('synthetic secret provider error');
    },
  });
  assert.equal(result.preparationState, 'prepared-local');
  assert.deepEqual(result.moduleStates, { memory: 'unavailable', references: 'unavailable' });
  assert.equal(result.baselineExportExact, true);
  assert.equal(result.recalledSources, 0);
  assert.equal(result.referenceAssociations, 0);
  assert.equal(result.artifacts.supplementText.includes('synthetic secret'), false);
  assert.ok(result.artifacts.supplementText.includes('unavailable'));
  assert.equal(result.museDelivery, 'manual-not-attempted');
});

it('carries optional NVIDIA metadata through preparation and export without changing source trust', async () => {
  let calls = 0;
  const result = await hackathonRehearsal({
    references: syntheticReference,
    semanticRanker: {
      async rank({ candidates }) {
        calls++;
        assert.ok(candidates.length > 0 && candidates.length <= 20);
        return {
          model: 'nvidia/nemotron-3-embed-1b',
          revision: 'c0c9fea93ea424587517f2c59e20db9f1d6bf615',
          candidates: candidates.map((item) => ({ sourceId: item.sourceId, score: 0.25 })),
        };
      },
    },
  });
  assert.ok(calls >= 3);
  assert.equal(result.semantic.status, 'available');
  assert.equal(result.artifacts.supplement.memory.semantic?.status, 'available');
  assert.ok(
    result.artifacts.supplement.memory.hits
      .filter((hit) => hit.evidence.verification === 'authored')
      .every((hit) => hit.evidence.modelConfidence === null),
  );
  assert.equal(result.baselineExportExact, true);
});
