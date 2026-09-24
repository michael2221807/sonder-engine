import { it, expect, vi, afterEach } from 'vitest';
import { EngramManager } from './engram-manager';
import { VectorStore } from './vector-store';
import { StateManager } from '../../core/state-manager';
import { DEFAULT_ENGINE_PATHS as P } from '../../pipeline/types';
import type { AIService } from '../../ai/ai-service';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('a load during real Engram dedup cannot be swallowed as an embedding failure or write into the new tree', async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ enabled: true, knowledgeEdgeMode: 'active' }) });
  const state = new StateManager(); state.loadTree({});
  state.set(P.roundNumber, 7);
  state.set('系统.扩展.engramMemory', {
    events: [], entities: [], relations: [],
    v2Edges: [{ id: 'old', sourceEntity: 'A', targetEntity: 'B', fact: 'A knows B', episodes: [],
      createdAtRound: 1, lastSeenRound: 1, learnedAtRound: 1, is_embedded: true }],
    meta: { schemaVersion: 5, eventCount: 0 },
  });
  let stale = false;
  const load = vi.spyOn(VectorStore.prototype, 'load').mockImplementation(async () => {
    state.loadTree({ marker: 'new loaded save' }); stale = true;
    return { eventVectors: {}, entityVectors: {}, edgeVectors: {}, model: '', dimensions: 0 } as never;
  });
  const manager = new EngramManager({} as AIService, undefined, () => ({ profileId: 'p', slotId: 's' }));
  await expect(manager.processResponse({ text: 'old narrative', knowledgeFacts: [{ fact: 'A helps B', sourceEntity: 'A', targetEntity: 'B' }] },
    state, { guard: () => { if (stale) throw new Error('stale round'); } })).rejects.toThrow('stale round');
  expect(load).toHaveBeenCalledTimes(1);
  expect(state.toSnapshot()).toEqual({ marker: 'new loaded save' });
});
