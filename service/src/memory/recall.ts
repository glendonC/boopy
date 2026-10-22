import { EvidenceRecord, evidenceSourceId, Supersession } from '../evidence-contract.ts';
import { tokenize } from './hmem/embeddings.ts';
import { MemoryRetrievalService } from './hmem/memoryRetrieval.ts';
import { MemoryStoreService } from './hmem/memoryStore.ts';
import { TrustLedgerService } from './hmem/trustLedger.ts';
export type RecallHit = {
  evidence: EvidenceRecord;
  relevance: number;
  retrievalConfidence: number;
};
/** Local derived index, rebuilt per query; caller selects authoritative evidence and links. */
export class MemoryRecall {
  private readonly records = new Map<string, EvidenceRecord>();
  private readonly successors = new Map<string, string>();
  constructor(records: EvidenceRecord[], supersessions: Supersession[] = []) {
    for (const input of records) {
      const record = EvidenceRecord.parse(input);
      if (record.sourceId !== evidenceSourceId(record))
        throw new Error('Invalid evidence source ID');
      const old = this.records.get(record.sourceId);
      if (old && JSON.stringify(old) !== JSON.stringify(record))
        throw new Error('Conflicting duplicate evidence');
      this.records.set(record.sourceId, structuredClone(record));
    }
    for (const input of supersessions) {
      const link = Supersession.parse(input);
      const before = evidenceSourceId(link.predecessor),
        after = evidenceSourceId(link.successor);
      if (!this.records.has(before) || !this.records.has(after))
        throw new Error('Unknown correction endpoint');
      if (before === after) throw new Error('Self supersession');
      if (this.successors.has(before) && this.successors.get(before) !== after)
        throw new Error('Conflicting successors');
      this.successors.set(before, after);
    }
    for (const start of this.successors.keys()) {
      const seen = new Set<string>();
      let next: string | undefined = start;
      while (next !== undefined) {
        if (seen.has(next)) throw new Error('Cyclic supersession');
        seen.add(next);
        next = this.successors.get(next);
      }
    }
  }
  query(
    text: string,
    options: {
      enabled?: boolean;
      topN?: number;
      threshold?: number;
      semanticScores?: ReadonlyMap<string, number>;
    } = {},
  ): RecallHit[] {
    if (options.enabled === false || !text.trim()) return [];
    const topN = options.topN ?? 5,
      threshold = options.threshold ?? 0.35;
    if (
      !Number.isInteger(topN) ||
      topN < 1 ||
      topN > 20 ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    )
      throw new Error('Invalid recall bounds');
    if (options.semanticScores)
      for (const [sourceId, score] of options.semanticScores) {
        if (
          !this.records.has(sourceId) ||
          this.successors.has(sourceId) ||
          !Number.isFinite(score) ||
          score < -1 ||
          score > 1
        )
          throw new Error('Invalid semantic source score');
      }
    const clock = () => 0; // Reindex time is not evidence freshness.
    const ledger = new TrustLedgerService(clock);
    const store = new MemoryStoreService(clock, ledger, 'boopy-memory-projection');
    const sources = new Map<string, EvidenceRecord>();
    const ids = new Map<string, string>();
    for (const record of this.records.values()) {
      const memory = store.add({
        content: [
          record.label,
          record.statement,
          record.gloss ?? '',
          record.note ?? '',
          ...record.text,
        ].join('\n'),
        source: record.sourceId,
        confidence: 1,
        type: 'factual',
        layer: 'long_term',
        provenance: {
          origin: record.origin === 'model' ? 'model_response' : 'document',
          learnedAt: 0,
          label: record.sourceId,
          refs: record.humanActions.map((action) => action.eventId),
        },
      });
      sources.set(memory.id, record);
      ids.set(record.sourceId, memory.id);
    }
    // H-MEM's one-to-one reciprocal field cannot represent a many-to-one correction.
    // All predecessors get the explicit successor; authoritative links remain outside H-MEM.
    const incoming = new Map<string, string[]>();
    for (const [before, after] of this.successors) {
      const predecessorId = ids.get(before),
        successorId = ids.get(after);
      if (!predecessorId || !successorId) throw new Error('Missing memory correction endpoint');
      store.update(predecessorId, { supersededBy: successorId });
      incoming.set(after, [...(incoming.get(after) ?? []), predecessorId]);
    }
    for (const [after, before] of incoming) {
      const successorId = ids.get(after);
      if (successorId && before.length === 1) store.update(successorId, { supersedes: before[0] });
    }
    const retrieval = new MemoryRetrievalService(store, ledger, clock, 'boopy-memory-projection');
    // A short explicit name/gloss is diluted by its full provenance-bearing statement in
    // the reference score. Rescue exact token sequences only, never substrings or synonyms.
    // Explicit thresholds retain their strict caller-selected semantics; scores stay unchanged.
    const queryTokens = tokenize(text);
    const exactField = (record: EvidenceRecord | undefined) =>
      record !== undefined &&
      [record.label, record.gloss ?? ''].some((field) => {
        const terms = tokenize(field);
        return (
          terms.length > 0 &&
          queryTokens.some((_, start) =>
            terms.every((term, offset) => queryTokens[start + offset] === term),
          )
        );
      });
    // Exclude before top-N; supersession does not disclose an unselected replacement.
    return store
      .all()
      .filter((memory) => !this.successors.has(memory.source))
      .map((memory) => ({
        memory,
        relevance: retrieval.scoreOne(memory, text, options.semanticScores?.get(memory.source)),
        exactFieldMatch: options.threshold === undefined && exactField(sources.get(memory.id)),
      }))
      .filter((hit) => hit.relevance >= threshold || hit.exactFieldMatch)
      .sort(
        (a, b) =>
          Number(b.exactFieldMatch) - Number(a.exactFieldMatch) ||
          b.relevance - a.relevance ||
          a.memory.source.localeCompare(b.memory.source),
      )
      .slice(0, topN)
      .map((hit) => {
        const evidence = sources.get(hit.memory.id);
        if (!evidence) throw new Error('Missing source evidence');
        return {
          evidence: structuredClone(evidence),
          relevance: hit.relevance,
          retrievalConfidence: hit.memory.confidence,
        };
      });
  }
}
