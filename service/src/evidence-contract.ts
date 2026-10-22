import { z } from 'zod';

export const EvidenceRef = z.object({ packageId: z.string().min(1), itemId: z.string().min(1) });
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export function evidenceSourceId(ref: EvidenceRef): string {
  return `${encodeURIComponent(ref.packageId)}:${encodeURIComponent(ref.itemId)}`;
}

export const HumanAction = z.object({
  eventId: z.string(),
  op: z.string(),
  at: z.string(),
  utteranceId: z.string().nullable(),
});

/** Source associations are recorded facts; null means no recorded association. */
export const EvidenceRecord = EvidenceRef.extend({
  sourceId: z.string(),
  kind: z.string(),
  label: z.string(),
  gloss: z.string().optional(),
  statement: z.string(),
  note: z.string().optional(),
  origin: z.enum(['model', 'person']),
  disposition: z.enum(['context', 'intent', 'question', 'known', 'rejected']),
  verification: z.enum(['accepted', 'confirmed', 'authored', 'corrected', 'unconfirmed']),
  modelConfidence: z.number().min(0).max(1).nullable(),
  observationId: z.string().nullable(),
  sourceContext: z
    .enum([
      'current-surroundings',
      'displayed-image',
      'virtual-scene',
      'past-recollection',
      'unknown',
    ])
    .optional(),
  utteranceId: z.string().nullable(),
  interpretationId: z.string().nullable(),
  model: z.object({ provider: z.string(), id: z.string() }).nullable(),
  text: z.array(z.string()),
  humanActions: z.array(HumanAction),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const EvidenceBundle = z.object({ version: z.literal(1), records: z.array(EvidenceRecord) });

export const SupersedeRequest = z.object({ predecessor: EvidenceRef, successor: EvidenceRef });
export type SupersedeRequest = z.infer<typeof SupersedeRequest>;
export const Supersession = SupersedeRequest.extend({ eventId: z.string(), at: z.string() });
export type Supersession = z.infer<typeof Supersession>;

/** Never invent the missing associations in old packages or silently accept a new version. */
export function evidenceRecords(pkg: unknown): EvidenceRecord[] {
  const parsed = z
    .object({
      version: z.literal(2),
      id: z.string(),
      evidence: EvidenceBundle,
    })
    .parse(pkg);
  const ids = new Set<string>();
  for (const record of parsed.evidence.records) {
    if (
      record.packageId !== parsed.id ||
      record.sourceId !== evidenceSourceId(record) ||
      ids.has(record.sourceId)
    ) {
      throw new Error('Invalid or duplicate evidence identity.');
    }
    ids.add(record.sourceId);
  }
  return parsed.evidence.records;
}
