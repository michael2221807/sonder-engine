import 'fake-indexeddb/auto';
/**
 * The engram stack cleans a save's pseudo vectors when the save is opened (存档瘦身 D4A): the store's loadGame
 * announces the opened save, the stack's listener runs EngramManager.repairVectorDims on it. Real store, StateManager,
 * EngramManager and VectorStore (fake-indexeddb); no AI is called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createEngramStack } from './engram-stack';
import { StateManager } from '../engine/core/state-manager';
import { useEngineStateStore } from '../engine/stores/engine-state';
import { idbAdapter } from '../engine/persistence/idb-adapter';
import { VectorStore } from '../engine/memory/engram/vector-store';
import { pseudoEmbed } from '../engine/memory/engram/embedder';
import { DEFAULT_ENGINE_PATHS as P } from '../engine/pipeline/types';
import type { AIService } from '../engine/ai/ai-service';

const aiService = { getConfigForUsage: () => undefined } as unknown as AIService;
const real = (seed: number) => Array.from({ length: 8 }, (_, i) => Math.fround(Math.cos(seed * 3 + i)));

describe('engram stack — the pseudo-vector repair on opening a save', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('opening a save marks the entries of its pseudo vectors not embedded and records the repair', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const stateManager = new StateManager();
    const store = useEngineStateStore();
    store.linkStateManager(stateManager);
    const vectorStore = new VectorStore();
    const { engramManager } = createEngramStack({ aiService, stateManager, engineStateStore: store, vectorStore });
    const repair = vi.spyOn(engramManager, 'repairVectorDims');
    await idbAdapter.set('engram_vectors_prof_es_slot_1', {
      eventVectors: { e1: real(1), e2: real(2), p1: pseudoEmbed('fallback , 1') }, entityVectors: {}, edgeVectors: {}, model: 'm', dim: 8,
    });
    const event = (id: string) => ({
      id, subject: 'A', action: 'narrative', tags: [], text: id, summary: id,
      structured_kv: { event: id, role: [], location: [], time_anchor: '', causality: '', logic: [] }, is_embedded: true, roundNumber: 1,
    });

    store.loadGame({
      元数据: { 回合序号: 3 },
      系统: { 扩展: { engramMemory: { events: [event('e1'), event('e2'), event('p1')], entities: [], relations: [], v2Edges: [] } } },
    }, 'tianming', 'prof_es', 'slot_1');

    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith(stateManager, P.saveFormat);
    expect(await repair.mock.results[0].value).toEqual({ mainDim: 8, unmarked: 1, removed: 0 });
    const events = stateManager.get<Array<{ id: string; is_embedded: boolean }>>(`${P.engramMemory}.events`)!;
    expect(events.map((e) => [e.id, e.is_embedded])).toEqual([['e1', true], ['e2', true], ['p1', false]]);
    expect(stateManager.get(P.saveFormat)).toEqual({ version: 2, migratedAtRound: null, vectorDimRepaired: true });
  });
});
