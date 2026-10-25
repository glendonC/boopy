/**
 * Memory of practice: each assessed answer as one small evidence record in its own index, never
 * mixed with saved items, so no practice attempt reaches /v1/recall, MCP recall or a package. A
 * record holds Boopy's guess, the outside term and the source, and says what Boopy heard, never
 * what the person did. Practice on a subject the person marked wrong is left out before scoring,
 * as a replaced claim is in saved-item recall, so no ranking can bring it back.
 */
import { type EvidenceRecord, evidenceSourceId } from '../evidence-contract.ts';
import type { PracticeRecord } from '../interaction/tasks.ts';
import type { PracticeRow } from '../references/zetaris.ts';
import { MemoryRecall } from './recall.ts';

export type PracticeHit = {
  readonly sourceId: string;
  readonly referenceId: string;
  readonly relevance: number;
};

/** The source as one search token, so two sources never share a part of their ids. */
function sourceToken(sourceId: string): string {
  return sourceId.replace(/[^A-Za-z0-9]/g, '');
}

function evidence(record: PracticeRecord): EvidenceRecord {
  const ref = { packageId: `practice:${record.taskId}`, itemId: record.attemptEventId };
  return {
    ...ref,
    sourceId: evidenceSourceId(ref),
    kind: 'practice-attempt',
    label: record.guess,
    gloss: record.term,
    statement: record.term,
    origin: 'person',
    disposition: 'question',
    verification: 'unconfirmed',
    modelConfidence: null,
    observationId: null,
    utteranceId: null,
    interpretationId: null,
    model: null,
    text: [sourceToken(record.sourceId)],
    humanActions: [],
  };
}

/**
 * Earlier practice for Boopy's guess or for this source: two H-MEM queries, one by the guess and
 * one by the source, over the practice records that still count. The Q-ids come back highest
 * relevance first, at most eight, for the term pick to look up; a score never confirms anything.
 */
export function recallPractice(
  records: readonly PracticeRecord[],
  query: { readonly guess: string; readonly sourceId: string },
): { readonly hits: PracticeHit[]; readonly recalled: string[] } {
  const counted = records.filter((record) => !record.excluded);
  if (counted.length === 0) return { hits: [], recalled: [] };
  const byEvidence = new Map(counted.map((record) => [evidence(record).sourceId, record]));
  const recall = new MemoryRecall(counted.map(evidence));
  const best = new Map<string, PracticeHit>();
  for (const text of [query.guess, sourceToken(query.sourceId)])
    for (const hit of recall.query(text, { topN: 8 })) {
      const record = byEvidence.get(hit.evidence.sourceId);
      const prior = best.get(hit.evidence.sourceId);
      if (record !== undefined && (prior === undefined || prior.relevance < hit.relevance))
        best.set(hit.evidence.sourceId, {
          sourceId: hit.evidence.sourceId,
          referenceId: record.referenceId,
          relevance: hit.relevance,
        });
    }
  const hits = [...best.values()]
    .sort((a, b) => b.relevance - a.relevance || a.sourceId.localeCompare(b.sourceId))
    .slice(0, 8);
  return { hits, recalled: [...new Set(hits.map((hit) => hit.referenceId))] };
}

/** The practice table's rows: every assessed answer that still counts, as the journal holds it. */
export function practiceRows(records: readonly PracticeRecord[]): PracticeRow[] {
  return records
    .filter((record) => !record.excluded)
    .map((record) => ({
      attemptId: record.attemptEventId,
      taskId: record.taskId,
      sourceId: record.sourceId,
      referenceId: record.referenceId,
      language: record.language,
      result: record.result,
      recognitionUncertain: true,
      attemptedAt: record.at,
    }));
}
