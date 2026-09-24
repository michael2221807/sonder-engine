import { describe, it, expect, vi } from 'vitest';
import { GameOrchestrator } from './game-orchestrator';
import { eventBus } from './event-bus';

// Exercise the actual host save method with injected persistence, not an alternate implementation.
function harness() {
  let slot = { profileId: 'p', slotId: 'a' }, round = 89;
  const save = vi.fn(async (_p: string, _s: string, _tree: unknown, _meta: unknown,
    commit: { guard: () => void; committed: () => void }) => { commit.guard(); commit.committed(); });
  const host = Object.create(GameOrchestrator.prototype) as {
    abortController: AbortController | null; _subPipelineActive: boolean; requestedSaveActive: boolean;
    stateRevision: number; pendingSave: typeof slot | null; subPipelines: object;
    _getActiveSlot: () => typeof slot; _stateManager: { toSnapshot: () => unknown };
    _saveManager: { saveGame: typeof save }; flushRequestedSave: () => Promise<void>;
  };
  Object.assign(host, { abortController: null, _subPipelineActive: false, requestedSaveActive: false,
    stateRevision: 0, pendingSave: null, subPipelines: {}, _getActiveSlot: () => slot,
    _stateManager: { toSnapshot: () => ({ round }) }, _saveManager: { saveGame: save } });
  return { host, save, queue: () => { host.pendingSave = { ...slot }; },
    round: (value: number) => { round = value; }, slot: (id: string) => { slot = { ...slot, slotId: id }; } };
}

describe('ordinary saves cannot persist half a round', () => {
  it('reports rejection for every busy owner without starting a round', async () => {
    const events: unknown[] = [];
    const off = eventBus.on('pipeline:input-rejected', p => { events.push(p); });
    const h = harness();
    const host = h.host as unknown as { runRound: (text: string, state: unknown) => Promise<void> };
    try {
      h.host._subPipelineActive = true; await host.runRound('draft1', {});
      h.host._subPipelineActive = false; h.host.requestedSaveActive = true; await host.runRound('draft2', {});
      h.host.requestedSaveActive = false; h.host.subPipelines = { stateEditInProgress: () => true }; await host.runRound('draft3', {});
      expect(events).toEqual([{ text: 'draft1' }, { text: 'draft2' }, { text: 'draft3' }]);
    } finally { off(); }
  });
  it('drains pending requests when an external editor settles', async () => {
    const h = harness(); let editing = true;
    h.host.subPipelines = { stateEditInProgress: () => editing };
    h.queue(); await h.host.flushRequestedSave(); expect(h.save).not.toHaveBeenCalled();
    editing = false;
    (h.host as unknown as GameOrchestrator).onStateEditSettled();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
  });
  it.each([89, 90])('waits for rollback or completion and saves only final round %s', async final => {
    const h = harness(); h.host.abortController = new AbortController(); h.round(90);
    h.queue(); await h.host.flushRequestedSave(); h.queue(); await h.host.flushRequestedSave();
    expect(h.save).not.toHaveBeenCalled();
    h.round(final); h.host.abortController = null; await h.host.flushRequestedSave();
    expect(h.save).toHaveBeenCalledTimes(1); expect(h.save.mock.calls[0][2]).toEqual({ round: final });
  });
  it('does not send a queued request to another slot and waits for subpipelines', async () => {
    const h = harness(); h.host._subPipelineActive = true; h.queue();
    await h.host.flushRequestedSave(); expect(h.save).not.toHaveBeenCalled();
    h.slot('b'); h.host._subPipelineActive = false; await h.host.flushRequestedSave();
    expect(h.save).not.toHaveBeenCalled();
  });
  it('checks the loaded revision again inside the persistence transaction', async () => {
    const h = harness(); h.queue();
    h.save.mockImplementationOnce(async (_p, _s, _tree, _meta, commit) => {
      h.host.stateRevision++; expect(() => commit.guard()).toThrow('存档已切换');
    });
    await h.host.flushRequestedSave(); expect(h.host.requestedSaveActive).toBe(false);
  });
});
