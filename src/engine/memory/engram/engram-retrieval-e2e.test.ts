/**
 * Engram retrieval E2E — REAL embed → merge → retrieve (no mocked vectorization).
 *
 * H-1 fix (2026-05-28): the existing integration test mocks vectorizePending /
 * deleteEdgeVectors (engram-editor-integration.test.ts:110-111), so Story 1's
 * headline acceptance — "用户写入的关系，下回合 AI 能检索到" — had NO real evidence
 * (plan §6.2 calls it the 核心验证标准). This test wires the REAL EngramManager +
 * REAL VectorStore + REAL Embedder (pseudoEmbed fallback, no network) + REAL
 * UnifiedRetriever and asserts a user-created edge is actually retrievable after
 * vectorization.
 *
 * ── IDB note ──────────────────────────────────────────────────────────────
 * VectorStore persists vectors via idbAdapter (IndexedDB). vitest runs in a
 * `node` environment with no IndexedDB, so we substitute idbAdapter with an
 * in-memory Map. This swaps ONLY the storage byte-bucket — VectorStore, Embedder,
 * cosineSimilarity, RRF and BM25 all run for real. The EngramManager's internal
 * VectorStore and the retriever's VectorStore share this Map under the same slot
 * key, exactly as two real instances would share IndexedDB.
 *
 * ── pseudoEmbed / CJK gotcha ─────────────────────────────────────────────
 * pseudoEmbed (embedder.ts:163) tokenizes on `/[\s一-鿿]+/`, which yields
 * ZERO tokens (a degenerate all-zero vector) for pure-CJK text. So for Chinese
 * content the cosine signal is dead and retrieval rides entirely on BM25 (which
 * DOES tokenize CJK via unigram + bigram — search-utils.ts:tokenizeChinese).
 * We therefore prove BOTH:
 *   1. the embedding→merge→cosine machinery, using English content (where
 *      pseudoEmbed produces a non-degenerate, cosine-discriminative vector), and
 *   2. the realistic shipped behaviour (a Chinese user edge is retrievable next
 *      round) — which, offline, is carried by BM25, and we assert the cosine
 *      vector is degenerate so the limitation is documented, not hidden.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory stand-in for IndexedDB. Declared via vi.hoisted so the (hoisted)
// vi.mock factory below can close over it.
const { idbStore } = vi.hoisted(() => ({ idbStore: new Map<string, unknown>() }));

vi.mock('@/engine/persistence/idb-adapter', () => ({
  idbAdapter: {
    async get<T>(key: string): Promise<T | undefined> {
      return idbStore.has(key) ? (structuredClone(idbStore.get(key)) as T) : undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      idbStore.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<void> {
      idbStore.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...idbStore.keys()];
    },
    async clear(): Promise<void> {
      idbStore.clear();
    },
  },
}));

import { EngramManager } from '@/engine/memory/engram/engram-manager';
import { EngramEditor } from '@/engine/memory/engram/engram-editor';
import { UnifiedRetriever, type UnifiedRetrieverConfig } from '@/engine/memory/engram/unified-retriever';
import { VectorStore } from '@/engine/memory/engram/vector-store';
import { Embedder, pseudoEmbed } from '@/engine/memory/engram/embedder';
import { createMockStateManager } from '@/engine/__test-utils__/state-manager.mock';
import type { AIService } from '@/engine/ai/ai-service';
import type { StateManager } from '@/engine/core/state-manager';

const ENGRAM_PATH = '系统.扩展.engramMemory';
const ROUND_PATH = '元数据.回合序号';
const SLOT = { profileId: 'p1', slotId: 's1' };
const PATHS = { engramMemory: ENGRAM_PATH, roundNumber: ROUND_PATH };

// AIService stub whose embedding config is absent → Embedder.callEmbeddingAPI
// throws → embed() falls back to deterministic pseudoEmbed (offline, no network).
const aiService = { getConfigForUsage: () => undefined } as unknown as AIService;

const RETRIEVER_CONFIG: UnifiedRetrieverConfig = {
  embedding: { enabled: true, topK: 20, minScore: 0.3 },
  rerank: { enabled: false, topN: 10 },
  shortTermWindow: 0,
  maxCandidates: 20,
};

/** Minimal engram state. A seed event is required: retrieve() returns '' when events is empty (unified-retriever.ts:102). */
function makeEngramState(round: number) {
  return {
    系统: {
      扩展: {
        engramMemory: {
          events: [
            {
              id: 'evt_seed',
              subject: 'seed',
              action: 'seed',
              tags: [],
              text: 'seed event',
              summary: 'seed event',
              structured_kv: { event: '', role: [], location: [], time_anchor: '', causality: '', logic: [] },
              is_embedded: false,
              roundNumber: 1,
            },
          ],
          entities: [],
          relations: [],
          v2Edges: [],
          meta: {
            lastUpdated: 0,
            eventCount: 1,
            embeddedEventCount: 0,
            embeddedEntityCount: 0,
            schemaVersion: 5,
            v2PendingReview: null,
          },
        },
      },
    },
    元数据: { 回合序号: round },
  };
}

function makeStack(round = 5) {
  const { sm } = createMockStateManager(makeEngramState(round));
  const manager = new EngramManager(aiService, PATHS, () => SLOT);
  const editor = new EngramEditor(sm as unknown as StateManager, manager, PATHS);
  const retriever = new UnifiedRetriever(
    new VectorStore(),
    new Embedder(aiService),
    undefined,            // reranker (rerank disabled)
    RETRIEVER_CONFIG,
    undefined,            // debug recorder
    () => SLOT,           // same slot as the manager → shares merged vectors
    PATHS,
  );
  return { sm: sm as unknown as StateManager, manager, editor, retriever };
}

function l2norm(vec: ArrayLike<number>): number {
  return Math.sqrt(Array.from(vec).reduce((s, x) => s + x * x, 0));
}

beforeEach(() => {
  idbStore.clear();
});

describe('Engram retrieval E2E — real embed → merge → retrieve', () => {
  it('English: a user edge is embedded into a non-degenerate vector and retrieved via cosine', async () => {
    const { sm, editor, retriever } = makeStack();

    // Story 1 user-CRUD path: user creates two entities + a relationship edge.
    await editor.createEntity({ name: 'Alice', type: 'npc', summary: 'a wandering swordmaster' });
    await editor.createEntity({ name: 'Bob', type: 'npc', summary: 'a court physician' });
    const fact = 'Alice secretly betrayed Bob during the northern council';
    const { edge } = await editor.createEdge({ sourceEntity: 'Alice', targetEntity: 'Bob', fact });

    // Round-boundary vectorization (deferred — models "下回合"): embeds the 2 entities + 1 edge.
    // vectorizePending counts entities+edges only, never events (engram-manager.ts:173-177).
    const { vectorized } = await editor.vectorizePending();
    expect(vectorized).toBe(3); // 2 entities (Alice, Bob) + 1 edge

    // Prove embed→merge produced a usable, non-degenerate vector (not the CJK zero vector).
    const stored = await new VectorStore().load(SLOT.profileId, SLOT.slotId);
    const edgeVec = stored.edgeVectors[edge.id];
    expect(edgeVec).toBeDefined();
    expect(l2norm(edgeVec)).toBeGreaterThan(0);

    // Prove the stored vector is cosine-discriminative against a related query
    // (this is the embedding signal the retriever uses, verified directly).
    // Actual cosine ≈ 0.61 with pseudoEmbed FNV-1a; 0.3 mirrors the retriever's minScore filter.
    const queryVec = pseudoEmbed('Alice betrayed Bob');
    expect(new VectorStore().cosineSimilarity(queryVec, edgeVec)).toBeGreaterThan(0.3);

    // Full retriever surfaces the user edge. The edge is NOT connected to the
    // player, so BFS cannot seed it — the hit comes from cosine + BM25.
    const out = await retriever.retrieve(
      'Alice betrayed Bob',
      { playerName: 'player', locationDesc: '', recentNpcNames: [] },
      sm,
    );
    expect(out).toContain(fact);
  });

  it('Chinese (shipped path): a user edge is retrievable next round via BM25 (cosine degenerate under pseudoEmbed)', async () => {
    const { sm, editor, retriever } = makeStack();

    await editor.createEntity({ name: '林惊羽', type: 'npc', summary: '青城派大弟子' });
    await editor.createEntity({ name: '苏婉儿', type: 'npc', summary: '药谷传人' });
    const fact = '林惊羽暗中救过苏婉儿一命，两人因此结为生死之交';
    const { edge } = await editor.createEdge({ sourceEntity: '林惊羽', targetEntity: '苏婉儿', fact });

    const { vectorized } = await editor.vectorizePending();
    expect(vectorized).toBe(3);

    const stored = await new VectorStore().load(SLOT.profileId, SLOT.slotId);
    const edgeVec = stored.edgeVectors[edge.id];
    expect(edgeVec).toBeDefined();

    // Document the limitation: pseudoEmbed does NOT tokenize CJK semantics
    // (it splits on `/[\s一-鿿]+/`, so only stray non-CJK chars like punctuation
    // survive). A pure-CJK query tokenizes to nothing → a degenerate vector →
    // cosine yields 0 against any stored edge. So the cosine signal cannot fire
    // for Chinese content and retrieval must ride on BM25.
    const cjkQuery = '林惊羽和苏婉儿是什么关系';
    expect(l2norm(pseudoEmbed(cjkQuery))).toBe(0); // CJK query → degenerate query vector
    // cosineSimilarity returns exactly 0 for a zero-norm input (vector-store.ts:166-167),
    // so cosine cannot fire for any stored edge regardless of its vector.
    expect(new VectorStore().cosineSimilarity(pseudoEmbed(cjkQuery), edgeVec)).toBe(0);

    // The full retriever STILL surfaces the user edge for the Chinese query —
    // proving the shipped "下回合 AI 能检索到" works offline via the BM25 signal.
    const out = await retriever.retrieve(
      cjkQuery,
      { playerName: '主角', locationDesc: '', recentNpcNames: [] },
      sm,
    );
    expect(out).toContain(fact);
  });
});
