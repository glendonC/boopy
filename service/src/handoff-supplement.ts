import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EvidenceRecord, evidenceSourceId } from './evidence-contract.ts';
import type { RecallHit } from './memory/recall.ts';
export const ReferenceRow = z
  .object({
    sourceId: z.string().min(1),
    packageId: z.string().min(1),
    itemId: z.string().min(1),
    revisionId: z.string().nullable(),
    referenceId: z.string().min(1),
    referenceSource: z.string().min(1),
    referenceVersion: z.string().min(1),
    updatedAt: z.iso.datetime(),
    referenceStatus: z.enum(['synthetic-unreviewed', 'external-unreviewed']),
    sourceRecordSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    conceptKey: z.string().min(1).optional(),
    englishGloss: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    referenceUrl: z.url(),
    koreanTerm: z.string().min(1).max(200),
  })
  .strict();
export type SyntheticReferenceRow = z.infer<typeof ReferenceRow>;
export const SemanticRanking = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      provider: z.literal('nvidia'),
      model: z.literal('nvidia/nemotron-3-embed-1b'),
      revision: z.literal('c0c9fea93ea424587517f2c59e20db9f1d6bf615'),
    })
    .strict(),
  z.object({ status: z.enum(['disabled', 'unavailable']), provider: z.literal('nvidia') }).strict(),
]);
export type SelectedSupplement = {
  synthetic: boolean;
  baselinePackageId: string;
  selectedPackageIds: string[];
  memory: {
    mode: 'disabled' | 'hmem-subset';
    status?: 'disabled' | 'available' | 'unavailable';
    semantic?: {
      status: 'disabled' | 'available' | 'unavailable';
      provider: 'nvidia';
      model?: string;
      revision?: string;
    };
    hits: RecallHit[];
    constraints: EvidenceRecord[];
    openQuestions: EvidenceRecord[];
  };
  references: {
    mode:
      | 'disabled'
      | 'synthetic-contract'
      | 'provided-synthetic-zetaris-receipt'
      | 'zetaris-reference-lookup';
    status?: 'disabled' | 'available' | 'unavailable';
    rows: { reference: SyntheticReferenceRow; evidence: EvidenceRecord }[];
  };
};

/** Separate operator-selected material: never appended to or committed as the saved package. */
export function renderSelectedSupplement(input: SelectedSupplement): string {
  if (input.memory.semantic) SemanticRanking.parse(input.memory.semantic);
  const selected = new Set(input.selectedPackageIds);
  if (!selected.has(input.baselinePackageId)) throw new Error('Baseline must be selected.');
  const check = (record: EvidenceRecord) => {
    EvidenceRecord.parse(record);
    if (!selected.has(record.packageId) || record.sourceId !== evidenceSourceId(record))
      throw new Error('Unselected or invalid source.');
  };
  for (const record of [
    ...input.memory.hits.map((hit) => hit.evidence),
    ...input.memory.constraints,
    ...input.memory.openQuestions,
  ])
    check(record);
  for (const row of input.references.rows) {
    check(row.evidence);
    if (input.references.mode === 'provided-synthetic-zetaris-receipt' && !input.synthetic)
      throw new Error('Fixture receipt requires synthetic context.');
    const reference = ReferenceRow.parse(row.reference);
    if (
      reference.sourceId !== row.evidence.sourceId ||
      reference.packageId !== row.evidence.packageId ||
      reference.itemId !== row.evidence.itemId
    )
      throw new Error('Mismatched reference association.');
    if (
      input.references.mode !== 'synthetic-contract' &&
      reference.sourceRecordSha256 !== evidenceRecordSha256(row.evidence)
    )
      throw new Error('Reference evidence hash mismatch.');
  }
  if (
    (input.memory.mode === 'disabled' &&
      (input.memory.hits.length ||
        input.memory.constraints.length ||
        input.memory.openQuestions.length)) ||
    (input.references.mode === 'disabled' && input.references.rows.length)
  )
    throw new Error('Disabled module returned material.');
  for (const hit of input.memory.hits)
    if (!Number.isFinite(hit.relevance) || !Number.isFinite(hit.retrievalConfidence))
      throw new Error('Invalid score.');
  return [
    input.synthetic
      ? 'SYNTHETIC REHEARSAL: FICTIONAL, NOT PERSONAL HISTORY.'
      : 'SELECTED BOOPY CONTEXT: use only within the chosen task.',
    'OPTIONAL SELECTED CONTEXT SUPPLEMENT, separate from the immutable Boopy package.',
    `Baseline package ID: ${JSON.stringify(input.baselinePackageId)}`,
    `Explicitly selected package IDs: ${JSON.stringify(input.selectedPackageIds)}`,
    'Nothing has been sent to Muse. Review and choose whether to paste this supplement separately.',
    'Retrieval scores measure ranking, not truth. Preserve each evidence verification, original nullable model confidence, source IDs, human actions and open questions. Selection and reference matching do not confirm a personal event.',
    input.references.mode === 'synthetic-contract'
      ? 'Synthetic reference contracts are not Zetaris runtime queries or verified language sources. Do not save this fictional example as personal history.'
      : 'Independent references do not verify personal events. Missing source associations stay unknown.',
    ...(input.synthetic
      ? [
          'Optional rehearsal request for Muse: use only the exact fictional personal account and explicitly attributed selected evidence for short Korean practice. Preserve negatives, uncertainty and corrections; invent no travel, transport, feelings, intensity or event dates. Do not schedule tasks or save this as personal history. These instructions do not establish provider retention behavior.',
        ]
      : []),
    `Memory mode: ${input.memory.mode}; status: ${input.memory.status ?? (input.memory.mode === 'disabled' ? 'disabled' : 'available')}`,
    ...(input.memory.semantic
      ? [`Semantic ranking (not verification): ${JSON.stringify(input.memory.semantic)}`]
      : []),
    ...input.memory.hits.map((hit) => `Recall: ${JSON.stringify(hit)}`),
    ...input.memory.constraints.map(
      (evidence) => `Constraint (not an included personal assertion): ${JSON.stringify(evidence)}`,
    ),
    ...input.memory.openQuestions.map(
      (evidence) => `Recorded question (not an inferred answer): ${JSON.stringify(evidence)}`,
    ),
    ...(input.references.mode === 'provided-synthetic-zetaris-receipt'
      ? [
          'Reference material below is a provided historical actual-query receipt for this exact synthetic fixture, not a fresh query or an ongoing connection.',
        ]
      : []),
    `Reference mode: ${input.references.mode}; status: ${input.references.status ?? (input.references.mode === 'disabled' ? 'disabled' : 'available')}`,
    ...input.references.rows.map(
      (row) => `Independent reference association (proposed): ${JSON.stringify(row)}`,
    ),
  ].join('\n');
}

/** Canonical full-record binding: sorted object keys, ordered arrays, exact strings/nulls. */
export function evidenceRecordSha256(record: EvidenceRecord): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => [key, sorted(entry)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(sorted(record)))
    .digest('hex');
}
