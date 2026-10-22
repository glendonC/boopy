/** Historical actual-query receipt for one exact synthetic fixture, never generic account connectivity. */
import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { type EvidenceRecord, evidenceSourceId } from './evidence-contract.ts';
import { evidenceRecordSha256, type SyntheticReferenceRow } from './handoff-supplement.ts';

const Row = z
  .object({
    sourceId: z.string(),
    packageId: z.string(),
    evidenceId: z.string(),
    revisionId: z.null(),
    capturedAt: z.string().nullable(),
    humanVerification: z.enum(['accepted', 'confirmed', 'authored', 'corrected', 'unconfirmed']),
    disposition: z.literal('context'),
    modelConfidence: z.number().min(0).max(1).nullable(),
    sourceRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
    conceptKey: z.literal('dune'),
    referenceSourceId: z.literal('wikidata:Q25391'),
    referenceId: z.literal('Q25391'),
    koreanTerm: z.string().min(1),
    englishGloss: z.literal('dune'),
    referenceVersion: z.string().regex(/^\d+$/),
    updatedAt: z.iso.datetime(),
    referenceStatus: z.literal('external-unreviewed'),
    referenceUrl: z.literal('https://www.wikidata.org/wiki/Q25391'),
    license: z.literal('CC0-1.0'),
  })
  .strict();
const Receipt = z
  .object({
    mode: z.literal('zetaris-runtime'),
    operation: z.literal('join'),
    contextSynthetic: z.literal(true),
    rows: z.array(Row).max(10),
  })
  .strict();
export async function providedSyntheticReferences(
  path: string,
  records: readonly EvidenceRecord[],
) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 32768)
    throw new Error('Choose a private bounded synthetic receipt.');
  const receipt = Receipt.parse(JSON.parse(await readFile(path, 'utf8')));
  const byId = new Map(records.map((record) => [record.sourceId, record]));
  const rows: SyntheticReferenceRow[] = receipt.rows.map((row) => {
    const record = byId.get(row.sourceId);
    if (
      !record ||
      record.sourceId !== evidenceSourceId(record) ||
      record.packageId !== row.packageId ||
      record.itemId !== row.evidenceId ||
      record.disposition !== row.disposition ||
      record.verification !== row.humanVerification ||
      record.modelConfidence !== row.modelConfidence ||
      evidenceRecordSha256(record) !== row.sourceRecordSha256
    )
      throw new Error('Receipt does not match exact selected evidence.');
    // The verified fixture has no recorded observation or revision; do not invent either.
    if (record.observationId !== null || row.capturedAt !== null)
      throw new Error('Unexpected synthetic timestamp association.');
    return {
      sourceId: record.sourceId,
      packageId: record.packageId,
      itemId: record.itemId,
      revisionId: null,
      sourceRecordSha256: row.sourceRecordSha256,
      conceptKey: row.conceptKey,
      referenceSource: row.referenceSourceId,
      referenceId: row.referenceId,
      koreanTerm: row.koreanTerm,
      englishGloss: row.englishGloss,
      referenceVersion: row.referenceVersion,
      updatedAt: row.updatedAt,
      referenceStatus: row.referenceStatus,
      referenceUrl: row.referenceUrl,
      license: row.license,
    };
  });
  return { mode: 'provided-synthetic-zetaris-receipt' as const, rows };
}
