import 'fake-indexeddb/auto';
/**
 * 存档瘦身 D4A, S6: retrieval and edge dedup give the same results as before the change. Before, the store gave the
 * retriever number lists; now every vector is a Float32Array, whether the save is from before (number lists, converted
 * when read), from this version or out of a backup's base64. An embedding is float32, so the values are the same, and
 * so is every score, every rank and every injected memory.
 *
 * The baseline is the code before the change: the retriever and the fact builder are unchanged but for their types,
 * so they are given the stored number lists as the old VectorStore.load gave them.
 */
import { describe, it, expect } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { StateManager } from '../../core/state-manager';
import { idbAdapter } from '../../persistence/idb-adapter';
import { UnifiedRetriever, type RetrievalContext, type UnifiedRetrieverConfig } from './unified-retriever';
import { VectorStore, vectorDataForBundle, vectorDataFromBundle, type VectorStoreData } from './vector-store';
import { buildFacts, type FactBuilderParams } from './fact-builder';
import type { Embedder } from './embedder';
import type { EngramEdge } from './knowledge-edge';
import type { EngramEntity } from './entity-builder';
import type { EngramEventNode } from './event-builder';
import type { StoredVector } from '../../persistence/save-format/vector-codec';

const DIM = 16;
const PATHS = { engramMemory: '系统.扩展.engramMemory', roundNumber: '元数据.回合序号' };
const CONFIG: UnifiedRetrieverConfig = {
  embedding: { enabled: true, topK: 8, minScore: 0.3 },
  rerank: { enabled: false, topN: 10 },
  shortTermWindow: 3,
  maxCandidates: 12,
};
const CONTEXT: RetrievalContext = { playerName: 'Alice', locationDesc: 'the market', recentNpcNames: ['Bob'] };
const NAMES = ['Alice', 'Bob', 'Carol', 'Dmitri', 'Elena', 'Farid', 'Gwen', 'Hiro'];
const WORDS = ['market', 'river', 'sword', 'letter', 'storm', 'temple', 'debt', 'feast', 'oath', 'lantern'];

/** A deterministic random source (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float32 values exactly, as an embedding API gives them, signs mixed. */
function vector(rand: () => number): number[] {
  return Array.from({ length: DIM }, () => Math.fround(rand() * 2 - 1));
}

/** `base` moved a little towards noise, as float32 values. */
function near(base: number[], rand: () => number, noise: number): number[] {
  return base.map((x) => Math.fround(x + (rand() * 2 - 1) * noise));
}

interface World {
  events: EngramEventNode[];
  entities: EngramEntity[];
  edges: EngramEdge[];
  /** The record as a save from before stored it: number lists. */
  stored: { eventVectors: Record<string, number[]>; entityVectors: Record<string, number[]>; edgeVectors: Record<string, number[]>; model: string; dim: number };
  query: number[];
}

function world(): World {
  const rand = random(20261009);
  const events: EngramEventNode[] = [];
  const eventVectors: Record<string, number[]> = {};
  for (let i = 1; i <= 30; i++) {
    const who = NAMES[i % NAMES.length];
    const what = WORDS[i % WORDS.length];
    const id = `evt_${i}`;
    events.push({
      id, subject: who, action: 'narrative', tags: ['narrative'], text: `${who} and the ${what} in round ${i}`,
      summary: `${who} ${what} ${WORDS[(i * 3) % WORDS.length]}`,
      structured_kv: { event: what, role: [who], location: ['the market'], time_anchor: '', causality: '', logic: [] },
      is_embedded: true, roundNumber: i,
    });
    eventVectors[id] = vector(rand);
  }
  const entities: EngramEntity[] = NAMES.map((name, i) => ({
    name, type: 'npc', summary: `${name} of the ${WORDS[i]}`, attributes: {}, firstSeen: 1, lastSeen: 30, mentionCount: 3, is_embedded: true,
  }));
  const entityVectors = Object.fromEntries(NAMES.map((name) => [name, vector(rand)]));
  const edges: EngramEdge[] = [];
  const edgeVectors: Record<string, number[]> = {};
  for (let i = 1; i <= 24; i++) {
    const source = NAMES[i % NAMES.length];
    const target = NAMES[(i * 5 + 1) % NAMES.length];
    const id = `edge_${i}`;
    edges.push({
      id, sourceEntity: source, targetEntity: target, fact: `${source} owes ${target} a ${WORDS[i % WORDS.length]} since round ${i}`,
      episodes: [`evt_${i}`], is_embedded: true, createdAtRound: i, lastSeenRound: i,
    });
    edgeVectors[id] = vector(rand);
  }
  // A query close to a few memories of each kind, so the cosine paths find and rank something.
  const toward = [eventVectors.evt_3, eventVectors.evt_17, entityVectors.Carol, edgeVectors.edge_5, edgeVectors.edge_11];
  const query = Array.from({ length: DIM }, (_, d) => Math.fround(toward.reduce((s, v) => s + v[d], 0) + (rand() * 2 - 1) * 0.4));
  return { events, entities, edges, stored: { eventVectors, entityVectors, edgeVectors, model: 'embed-1', dim: DIM }, query };
}

function stateWith(w: World): StateManager {
  const sm = new StateManager();
  sm.loadTree({
    元数据: { 回合序号: 31 },
    系统: {
      扩展: {
        engramMemory: {
          events: cloneDeep(w.events), entities: cloneDeep(w.entities), relations: [], v2Edges: cloneDeep(w.edges),
          meta: { lastUpdated: 0, eventCount: 30, embeddedEventCount: 30, embeddedEntityCount: 8, schemaVersion: 5, v2PendingReview: null },
        },
      },
    },
  });
  return sm;
}

/** The store before the change: load gave the record's number lists as they were. */
class StoreBeforeChange extends VectorStore {
  constructor(private readonly record: World['stored']) { super(); }
  override async load(): Promise<VectorStoreData> {
    return cloneDeep(this.record) as unknown as VectorStoreData;
  }
}

let next = 0;
async function slotHolding(record: unknown): Promise<{ profileId: string; slotId: string }> {
  next++;
  const slot = { profileId: `prof_f32_${next}`, slotId: 'slot_1' };
  await idbAdapter.set(`engram_vectors_${slot.profileId}_${slot.slotId}`, record);
  return slot;
}

/** What one retrieval gave: the text for the prompt, and every candidate with its scores and outcome. */
async function retrieval(w: World, store: VectorStore, slot: { profileId: string; slotId: string }) {
  const embedder = { embed: async (texts: string[]) => texts.map(() => [...w.query]) } as unknown as Embedder;
  const retriever = new UnifiedRetriever(store, embedder, undefined, CONFIG, undefined, () => slot, PATHS);
  const text = await retriever.retrieve('Carol and the debt at the river', CONTEXT, stateWith(w));
  const { capturedAt: _at, totalDurationMs: _ms, ...trace } = retriever.lastReadSnapshot!;
  return { text, trace };
}

describe('Float32Array vectors give the results the number lists gave (存档瘦身 D4A, S6)', () => {
  it('retrieval: same text, same candidates, same scores, from an old save, a new one and a backup', async () => {
    const w = world();
    const before = await retrieval(w, new StoreBeforeChange(w.stored), await slotHolding(w.stored));

    const typed = vectorDataFromBundle(w.stored);
    const fromOldSave = await retrieval(w, new VectorStore(), await slotHolding(w.stored));
    const fromNewSave = await retrieval(w, new VectorStore(), await slotHolding(typed));
    const fromBackup = await retrieval(w, new VectorStore(), await slotHolding(vectorDataFromBundle(JSON.parse(JSON.stringify(vectorDataForBundle(typed))))));

    // The baseline did use the vectors: memories of each kind came by meaning.
    expect(before.trace.pipeline.vectorEventCount).toBeGreaterThan(0);
    expect(before.trace.pipeline.vectorEntityCount).toBeGreaterThan(0);
    expect(before.trace.candidates.some((c) => c.source === 'edge')).toBe(true);
    expect(before.text.length).toBeGreaterThan(0);

    for (const after of [fromOldSave, fromNewSave, fromBackup]) {
      expect(after.text).toBe(before.text);
      expect(after.trace).toEqual(before.trace);
    }
  });

  it('edge dedup: same reinforced edges, renames and review pairs', () => {
    const w = world();
    const rand = random(7);
    const edge5 = w.edges.find((e) => e.id === 'edge_5')!;
    const edge9 = w.edges.find((e) => e.id === 'edge_9')!;
    const facts = [
      // The same pair as edge_5, nearly the same meaning, a longer text: reinforces it and renames it.
      { fact: `${edge5.fact}, as everyone at the market knows`, sourceEntity: edge5.sourceEntity, targetEntity: edge5.targetEntity, vec: near(w.stored.edgeVectors.edge_5, rand, 0.05) },
      // The same pair as edge_9, a related meaning: a review pair.
      { fact: `${edge9.sourceEntity} quarrels with ${edge9.targetEntity} about the lantern`, sourceEntity: edge9.sourceEntity, targetEntity: edge9.targetEntity, vec: near(w.stored.edgeVectors.edge_9, rand, 0.45) },
      // Another pair, close to edge_11: a broad review candidate.
      { fact: 'Gwen remembers the storm over the temple', sourceEntity: 'Gwen', targetEntity: 'Hiro', vec: near(w.stored.edgeVectors.edge_11, rand, 0.3) },
    ];
    const params: FactBuilderParams = {
      knowledgeFacts: facts.map(({ fact, sourceEntity, targetEntity }) => ({ fact, sourceEntity, targetEntity })),
      entities: cloneDeep(w.entities), currentEventId: 'evt_31', currentRound: 31,
    };
    const run = (edgeVectors: Record<string, StoredVector>) => {
      const edges = cloneDeep(w.edges);
      const result = buildFacts(cloneDeep(params), edges, new VectorStore(), edgeVectors,
        new Map(facts.map((f) => [f.fact, f.vec])), { reviewThreshold: 0.5, perFactCap: 3 });
      return { result, edges };
    };

    const before = run(cloneDeep(w.stored.edgeVectors));
    const after = run(vectorDataFromBundle(w.stored).edgeVectors);

    expect(before.result.reinforcedIds.length).toBeGreaterThan(0);
    expect(before.result.renamedEdgeIds.length).toBeGreaterThan(0);
    expect(before.result.pendingReviewPairs.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });
});
