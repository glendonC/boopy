import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { hackathonRehearsal } from './cli/hackathon-rehearsal.ts';
import { evidenceRecordSha256 } from './handoff-supplement.ts';
import { providedSyntheticReferences } from './provided-synthetic-reference.ts';

it('historical fixture receipt binds the entire selected record, not matching IDs or verification alone', async () => {
  const result = await hackathonRehearsal();
  const record = result.artifacts.supplement.memory.hits.find(
    (hit) => hit.evidence.sourceId === 'ctx_13:itm_11',
  )?.evidence;
  assert.ok(record);
  const hash = '780b1263aacccbdbd4feb9ad20384fcd9877a917f102fd843d9482b160ca7281';
  assert.equal(evidenceRecordSha256(record), hash);
  const directory = await mkdtemp(join(tmpdir(), 'boopy-bound-receipt-test-'));
  const path = join(directory, 'receipt.json');
  const receipt = {
    mode: 'zetaris-runtime',
    operation: 'join',
    contextSynthetic: true,
    rows: [
      {
        sourceId: record.sourceId,
        packageId: record.packageId,
        evidenceId: record.itemId,
        revisionId: null,
        capturedAt: null,
        humanVerification: record.verification,
        disposition: record.disposition,
        modelConfidence: record.modelConfidence,
        sourceRecordSha256: hash,
        conceptKey: 'dune',
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
  try {
    await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
    const imported = await providedSyntheticReferences(path, [record]);
    assert.equal(imported.mode, 'provided-synthetic-zetaris-receipt');
    assert.equal(imported.rows[0]?.sourceRecordSha256, hash);
    assert.equal(imported.rows[0]?.revisionId, null);
    assert.equal(imported.rows[0]?.referenceStatus, 'external-unreviewed');
    const changedStatement = structuredClone(record);
    changedStatement.statement = 'Different synthetic detail with identical IDs and trust.';
    await assert.rejects(providedSyntheticReferences(path, [changedStatement]));
    const changedAction = structuredClone(record);
    assert.ok(changedAction.humanActions[0]);
    changedAction.humanActions[0].eventId = 'different-action';
    await assert.rejects(providedSyntheticReferences(path, [changedAction]));
    await assert.rejects(providedSyntheticReferences(path, []));
    const changedContext = structuredClone(receipt);
    changedContext.contextSynthetic = false;
    await writeFile(path, JSON.stringify(changedContext));
    await assert.rejects(providedSyntheticReferences(path, [record]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
