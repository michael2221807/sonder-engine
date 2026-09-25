import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { VectorBoardAccess } from './board-access';
import { executeVectorOperation, initialVectorState, type PreparedVector, type VectorOperation, type VectorResult, type VectorState } from './runtime';
import { tasksAfterSave } from './genesis/post-save';
import { projectSavedElements } from './saved-elements';

let access: VectorBoardAccess;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v) });
  vi.stubGlobal('window', new EventTarget());
  writePlotVectorControl(true);
});
afterEach(() => { access?.dispose(); vi.unstubAllGlobals(); });
function setup() {
  const state = new StateManager(); state.loadTree({});
  state.set(P.plotVector, initialVectorState()); state.set(P.roundNumber, 7);
  let busy = false;
  const saveGame = vi.fn(async (_p: string, _s: string, _tree: unknown, _meta?: unknown,
    commit?: { guard: () => void; committed: () => void }) => { commit?.guard(); commit?.committed(); });
  const worker = { execute: vi.fn(<T extends VectorResult>(op: VectorOperation) => executeVectorOperation(op) as Promise<T>), cancelAll: vi.fn() };
  const settled = vi.fn(() => { expect(access.isSaving).toBe(false); });
  access = new VectorBoardAccess(state, { assertCurrent: vi.fn(async () => {}), saveGame },
    () => ({ profileId: 'p', slotId: 's' }), () => busy, {
      execute: <T extends VectorResult>(op: VectorOperation) => worker.execute(op) as Promise<T>, cancelAll: worker.cancelAll,
    }, undefined, settled);
  return { state, saveGame, worker, settled, busy: () => { busy = true; } };
}
it('preview uses the next round seed and layout-only save preserves every lifecycle field', async () => {
  const h = setup(), before = h.state.get<VectorState>(P.plotVector)!;
  const view = await access.open();
  expect(view.prepared.id).toBe('p/s/8');
  await view.preview(view.prepared.layout);
  expect(h.saveGame).not.toHaveBeenCalled();
  await view.save(view.prepared.layout);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
  expect(h.settled).toHaveBeenCalledTimes(1);
  expect(h.state.get(P.plotVector)).toEqual({ ...before, layout: view.prepared.layout });
  expect(h.worker.execute.mock.calls.every(([op]) => op.kind === 'prepare')).toBe(true);
  await expect(view.save(view.prepared.layout)).rejects.toThrow('stale');
});
it.each(['busy', 'load', 'changed', 'off'] as const)('rejects a stale draft after %s without saving', async reason => {
  const h = setup(), view = await access.open();
  if (reason === 'busy') h.busy();
  if (reason === 'load') h.state.loadTree(h.state.toSnapshot());
  if (reason === 'changed') h.state.set(P.roundNumber, 9);
  if (reason === 'off') writePlotVectorControl(false);
  await expect(view.save(view.prepared.layout)).rejects.toThrow('stale');
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('an aborted save never changes the live layout or session', async () => {
  const h = setup(), before = h.state.toSnapshot(), view = await access.open();
  h.saveGame.mockRejectedValue(new Error('transaction aborted'));
  await expect(view.save(view.prepared.layout)).rejects.toThrow('transaction aborted');
  expect(h.settled).toHaveBeenCalledTimes(1);
  expect(h.state.toSnapshot()).toEqual(before);
});
it('keeps the committed layout when later save metadata fails', async () => {
  const h = setup(), view = await access.open();
  h.saveGame.mockImplementation(async (_p, _s, _tree, _meta, commit) => {
    commit?.guard(); commit?.committed(); throw new Error('metadata');
  });
  await view.save(view.prepared.layout);
  expect(h.state.get<VectorState>(P.plotVector)?.layout).toEqual(view.prepared.layout);
});
it('a load after disk commit cannot receive the old layout in memory', async () => {
  const h = setup(), view = await access.open();
  h.saveGame.mockImplementation(async (_p, _s, _tree, _meta, commit) => {
    commit?.guard(); h.state.loadTree({ otherSlot: true }); commit?.committed();
  });
  await expect(view.save(view.prepared.layout)).rejects.toThrow('stale');
  expect(h.state.toSnapshot()).toEqual({ otherSlot: true });
});
it('gate 1: a malformed preview is never shown or saved, and the next preview works', async () => {
  const h = setup();
  const honest = h.worker.execute.getMockImplementation()!;
  h.worker.execute.mockImplementationOnce((async (op: VectorOperation) => {
    const result = await executeVectorOperation(op) as PreparedVector;
    return { ...result, layout: { ...result.layout, placements: { ...result.layout.placements, '01': 'ghost-card' } } };
  }) as never);
  await expect(access.open()).rejects.toThrow(/剧情动能计算结果无效（prepare）/);
  expect(h.saveGame).not.toHaveBeenCalled();
  h.worker.execute.mockImplementation(honest);
  const view = await access.open();
  h.worker.execute.mockImplementationOnce((async (op: VectorOperation) => {
    const result = await executeVectorOperation(op) as PreparedVector;
    return { ...result, result: { ...result.result, visits: result.board.budget.maxVisits + 1 } };
  }) as never);
  await expect(view.save(view.prepared.layout)).rejects.toThrow(/剧情动能计算结果无效（prepare）/);
  expect(h.saveGame).not.toHaveBeenCalled();
  await view.save(view.prepared.layout);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
});
it('lists obtained entries whose ability is not ready; the player retry holds the board like a save and is refused during a round', async () => {
  const h = setup();
  h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
  const task = tasksAfterSave({ id: 'x', success: true, before: [], after: projectSavedElements(h.state.toSnapshot()).entries })[0];
  h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'failed', error: 'boom' }] });
  let busy = false, heldDuringRetry: boolean | undefined;
  const regenerate = vi.fn(async () => { heldDuringRetry = retryAccess.isSaving; return { bound: true, requested: true }; });
  const retryAccess: VectorBoardAccess = new VectorBoardAccess(h.state, { assertCurrent: vi.fn(async () => {}), saveGame: h.saveGame },
    () => ({ profileId: 'p', slotId: 's' }), () => busy, {
      execute: <T extends VectorResult>(op: VectorOperation) => h.worker.execute(op) as Promise<T>, cancelAll: h.worker.cancelAll,
    }, undefined, () => {}, regenerate);
  try {
    const view = await retryAccess.open();
    expect(view.backlog.map(b => [b.id, b.name, b.state])).toEqual([['item:tea', '茶', 'failed']]);
    expect(view.prepared.board.cards.some(c => c.id === 'item:tea')).toBe(false); // never shown as a playable card
    expect(await retryAccess.regenerate('item:tea')).toEqual({ bound: true, requested: true });
    expect(heldDuringRetry).toBe(true);   // no round can start while it runs
    expect(retryAccess.isSaving).toBe(false);
    busy = true;
    await expect(retryAccess.regenerate('item:tea')).rejects.toThrow('busy');
    expect(regenerate).toHaveBeenCalledTimes(1);
  } finally { retryAccess.dispose(); }
});
