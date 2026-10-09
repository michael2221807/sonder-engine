import 'fake-indexeddb/auto';
/**
 * The engram stack cleans a save's pseudo vectors when the save is opened (存档瘦身 D4A): the store's loadGame
 * announces the opened save, the stack's listener runs EngramManager.repairVectorDims on it, with the round-start tree
 * a rollback would put back. Real store, StateManager, RollbackSnapshot, EngramManager and VectorStore
 * (fake-indexeddb); no AI is called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createEngramStack } from './engram-stack';
import { StateManager } from '../engine/core/state-manager';
import { RollbackSnapshot } from '../engine/core/rollback-snapshot';
import { useEngineStateStore } from '../engine/stores/engine-state';
import { idbAdapter } from '../engine/persistence/idb-adapter';
import { VectorStore } from '../engine/memory/engram/vector-store';
import { EngramManager } from '../engine/memory/engram/engram-manager';
import { pseudoEmbed } from '../engine/memory/engram/embedder';
import { DEFAULT_ENGINE_PATHS as P } from '../engine/pipeline/types';
import type { AIService } from '../engine/ai/ai-service';

const aiService = { getConfigForUsage: () => undefined } as unknown as AIService;
const real = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.fround(Math.cos(seed * 3 + i)));
const event = (id: string, embedded = true) => ({
  id, subject: 'A', action: 'narrative', tags: [], text: id, summary: id,
  structured_kv: { event: id, role: [], location: [], time_anchor: '', causality: '', logic: [] }, is_embedded: embedded, roundNumber: 1,
});
const engramTree = (round: number, pseudoEmbedded: boolean, marker?: Record<string, unknown>) => ({
  元数据: { 回合序号: round, 叙事历史: [] },
  系统: {
    扩展: {
      engramMemory: { events: [event('e1'), event('e2'), event('p1', pseudoEmbedded)], entities: [], relations: [], v2Edges: [] },
      ...(marker ? { saveFormat: marker } : {}),
    },
  },
});

function stack() {
  const stateManager = new StateManager();
  const store = useEngineStateStore();
  const rollbackSnapshot = new RollbackSnapshot(P);
  store.linkStateManager(stateManager);
  store.linkRollbackSnapshot(rollbackSnapshot);
  const { engramManager } = createEngramStack({ aiService, stateManager, engineStateStore: store, vectorStore: new VectorStore(), rollbackSnapshot });
  return { stateManager, store, rollbackSnapshot, repair: vi.spyOn(engramManager, 'repairVectorDims') };
}

const storeVectors = (slot: string) => idbAdapter.set(`engram_vectors_prof_es_${slot}`, {
  eventVectors: { e1: real(1), e2: real(2), p1: pseudoEmbed('fallback , 1') }, entityVectors: {}, edgeVectors: {}, model: 'm', dim: 8,
});
const eventKeys = async (slot: string) => Object.keys((await new VectorStore().load('prof_es', slot)).eventVectors).sort();

describe('engram stack — the pseudo-vector repair on opening a save', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.spyOn(EngramManager.prototype, 'isEnabled').mockReturnValue(true);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opening a save marks the entries of its pseudo vectors not embedded and records the repair', async () => {
    const { stateManager, store, repair } = stack();
    await storeVectors('slot_1');

    store.loadGame(engramTree(3, true), 'tianming', 'prof_es', 'slot_1');

    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith(stateManager, P.saveFormat, { profileId: 'prof_es', slotId: 'slot_1' }, expect.any(Function));
    expect(await repair.mock.results[0].value).toEqual({ mainDim: 8, unmarked: 1, removed: 0 });
    const events = stateManager.get<Array<{ id: string; is_embedded: boolean }>>(`${P.engramMemory}.events`)!;
    expect(events.map((e) => [e.id, e.is_embedded])).toEqual([['e1', true], ['e2', true], ['p1', false]]);
    expect(stateManager.get(P.saveFormat)).toEqual({ vectorDimRepaired: true });
  });

  it('hands over the round-start tree a rollback would put back: a vector its entry still has there stays', async () => {
    // A save as a round left it, after the repair: the entry not embedded, but the round-start tree it rolls back to
    // (the stored rollback record) still marks it embedded.
    const before = new StateManager();
    before.loadTree(engramTree(4, true));
    const holder = new RollbackSnapshot(P);
    before.set(P.rollbackPatch, holder.capture(before.toSnapshot()), 'system');
    before.set(P.roundNumber, 5, 'system');
    before.set(`${P.engramMemory}.events.2.is_embedded`, false, 'system');
    before.set(P.saveFormat, { vectorDimRepaired: true }, 'system');
    const saved = JSON.parse(JSON.stringify(holder.treeToSave(before.liveTree()))) as Record<string, unknown>;

    const { store, rollbackSnapshot, repair } = stack();
    await storeVectors('slot_2');
    store.loadGame(saved, 'tianming', 'prof_es', 'slot_2');

    const rollbackTrees = repair.mock.calls[0][3] as () => readonly unknown[];
    expect(rollbackTrees()[0]).toBe(rollbackSnapshot.current()?.snapshot);
    expect(await repair.mock.results[0].value).toEqual({ mainDim: 8, unmarked: 0, removed: 0 });
    expect(await eventKeys('slot_2')).toEqual(['e1', 'e2', 'p1']);
  });
});
