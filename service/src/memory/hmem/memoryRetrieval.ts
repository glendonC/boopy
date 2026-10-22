// Hybrid retrieval score:
//
//   raw = 0.35*semantic + 0.20*keyword + 0.10*tag + 0.10*domain
//       + 0.15*entity   + 0.05*layer   + 0.05*recency - 0.20*superseded
//   score = clamp01(raw) * confidence          <- confidence multiplies AFTER the sum
//
// keyword = Jaccard of the top-8 query tokens vs memory tokens.
// layer weights: long_term 1.0, working 0.8, short_term 0.6.
// recency = exponential decay on lastAccessed, 14-day time constant.
// A replaced item is penalized here. Boopy's own search drops it before this score runs.
// Threshold 0.35 applies to the FINAL score; top N = 5.

import { cosine, embed, jaccard, tokenize } from './embeddings.ts';
import type { MemoryStoreService } from './memoryStore.ts';
import { snapshot } from './memoryStore.ts';
import type { TrustLedgerService } from './trustLedger.ts';
import type { FeedbackKind, MemoryRecord, QueryResult, RetrievedMemory } from './types.ts';
import { clamp01, DAY_MS, DEFAULTS, FEEDBACK_DELTAS } from './types.ts';

const LAYER_WEIGHT: Record<MemoryRecord['layer'], number> = {
  long_term: 1.0,
  working: 0.8,
  short_term: 0.6,
};

export class MemoryRetrievalService {
  private store: MemoryStoreService;
  private ledger: TrustLedgerService;
  private clock: () => number;
  private actor: string;
  constructor(
    store: MemoryStoreService,
    ledger: TrustLedgerService,
    clock: () => number,
    actor: string,
  ) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
    this.actor = actor;
  }

  scoreOne(memory: MemoryRecord, query: string, semanticOverride?: number): number {
    if (
      semanticOverride !== undefined &&
      (!Number.isFinite(semanticOverride) || semanticOverride < -1 || semanticOverride > 1)
    )
      throw new Error('Invalid semantic score');
    const queryEmbedding = embed(query);
    const queryTokens = tokenize(query).slice(0, 8);
    const queryEntities = this.store.extractEntities(query);
    const queryDomain = this.store.classifyDomain(query, [], 'general');
    return this.score(
      memory,
      queryEmbedding,
      queryTokens,
      queryEntities,
      queryDomain,
      semanticOverride,
    );
  }

  private score(
    m: MemoryRecord,
    queryEmbedding: number[],
    queryTokens: string[],
    queryEntities: string[],
    queryDomain: string,
    semanticOverride?: number,
  ): number {
    const semantic = clamp01(semanticOverride ?? cosine(queryEmbedding, m.embedding));
    const keyword = jaccard(queryTokens, tokenize(m.content));
    const tag = jaccard(
      queryTokens,
      m.tags.map((t) => t.toLowerCase()),
    );
    const domain = m.domain === queryDomain ? 1 : 0;
    const entity = jaccard(queryEntities, m.entities);
    const layer = LAYER_WEIGHT[m.layer];
    const ageDays = (this.clock() - m.lastAccessed) / DAY_MS;
    const recency = Math.exp(-ageDays / DEFAULTS.recencyDays);
    const superseded = m.supersededBy ? 1 : 0;
    const raw =
      0.35 * semantic +
      0.2 * keyword +
      0.1 * tag +
      0.1 * domain +
      0.15 * entity +
      0.05 * layer +
      0.05 * recency -
      0.2 * superseded;
    return clamp01(raw) * m.confidence;
  }

  query(query: string, opts?: { topN?: number; threshold?: number; chatId?: string }): QueryResult {
    const queryEmbedding = embed(query);
    const queryTokens = tokenize(query).slice(0, 8);
    const queryEntities = this.store.extractEntities(query);
    const queryDomain = this.store.classifyDomain(query, [], 'general');
    const threshold = opts?.threshold ?? DEFAULTS.retrievalThreshold;
    const topN = opts?.topN ?? DEFAULTS.retrievalTopN;

    const scored: RetrievedMemory[] = [];
    for (const m of this.store.all()) {
      if (opts?.chatId && m.chatId && m.chatId !== opts.chatId) continue;
      const s = this.score(m, queryEmbedding, queryTokens, queryEntities, queryDomain);
      if (s >= threshold) scored.push({ memory: m, relevance: s });
    }
    scored.sort((a, b) => b.relevance - a.relevance || a.memory.id.localeCompare(b.memory.id));
    const top = scored.slice(0, topN);

    for (const { memory } of top) {
      this.store.touch(memory.id);
      this.ledger.log(memory.id, 'read', this.actor, { details: { operation: 'query' } });
    }

    const strategy =
      top.length <= 1
        ? 'minimal'
        : top.some((t) => t.memory.type === 'personal' || t.memory.type === 'preference')
          ? 'personal'
          : 'comprehensive';
    return {
      memories: top,
      context: this.formatReinjection(top),
      trace: {
        retrievalReason: `hybrid ranking (domain: ${queryDomain})`,
        strategy,
        scores: Object.fromEntries(top.map((t) => [t.memory.id, Number(t.relevance.toFixed(4))])),
      },
    };
  }

  // Domain-grouped reinjection blocks with layer markers and entities (section 6.2).
  formatReinjection(items: RetrievedMemory[]): string {
    if (items.length === 0) return '';
    const byDomain = new Map<string, RetrievedMemory[]>();
    for (const it of items) {
      const list = byDomain.get(it.memory.domain) ?? [];
      list.push(it);
      byDomain.set(it.memory.domain, list);
    }
    const lines: string[] = ['[MEMORY CONTEXT]'];
    for (const [domain, list] of [...byDomain.entries()].sort()) {
      lines.push(`## ${domain}`);
      for (const { memory } of list) {
        const marker =
          memory.layer === 'long_term' ? 'LT' : memory.layer === 'working' ? 'WK' : 'ST';
        const ents = memory.entities.length ? ` (entities: ${memory.entities.join(', ')})` : '';
        lines.push(`- [${marker}] ${memory.content}${ents} <${memory.id}>`);
      }
    }
    lines.push('[/MEMORY CONTEXT]');
    return lines.join('\n');
  }

  // Exact feedback deltas (AGENTS.md section 9.2).
  feedback(memoryId: string, kind: FeedbackKind): void {
    const m = this.store.get(memoryId);
    if (!m) throw new Error(`H-MEM: unknown memory id ${memoryId}`);
    const prev = snapshot(m);
    if (kind === 'helpful') m.accessCount += 1;
    m.confidence = clamp01(m.confidence + FEEDBACK_DELTAS[kind]);
    if (kind === 'wrong' && !m.tags.includes('review')) m.tags.push('review');
    this.ledger.log(memoryId, 'feedback', this.actor, {
      previousState: prev,
      newState: snapshot(m),
      details: { kind, delta: FEEDBACK_DELTAS[kind] },
    });
    this.store.persist();
  }
}
