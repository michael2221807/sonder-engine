import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { VectorBoardAccess } from './board-access';
import { initialVectorState, type VectorState } from './runtime';
import { tasksAfterSave } from './genesis/post-save';
import { projectSavedElements } from './saved-elements';
import vectorRules from '../../../public/packs/tianming/rules/plot-vector.json';
import { parseSupplyRules } from './supply';

// The trip is computed in the page; a test can make an arrangement fail to compute.
const failing = vi.hoisted(() => ({ placed: false }));
vi.mock('./runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('./runtime')>();
  return { ...actual, prepareVector: (...args: Parameters<typeof actual.prepareVector>) => {
    if (failing.placed && Object.values(args[0].layout?.placements ?? {}).some(Boolean)) throw new Error('剧情动能这回合算不出来（test）');
    return actual.prepareVector(...args);
  } };
});

let access: VectorBoardAccess;
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v) });
  vi.stubGlobal('window', new EventTarget());
  writePlotVectorControl(true);
});
afterEach(() => { access?.dispose(); vi.unstubAllGlobals(); failing.placed = false; });
function setup(opts: { supply?: boolean } = {}) {
  const state = new StateManager(); state.loadTree({});
  state.set(P.plotVector, initialVectorState()); state.set(P.roundNumber, 7);
  let busy = false;
  const saveGame = vi.fn(async (_p: string, _s: string, _tree: unknown, _meta?: unknown,
    commit?: { guard: () => void; committed: () => void }) => { commit?.guard(); commit?.committed(); });
  const settled = vi.fn(() => { expect(access.isSaving).toBe(false); });
  access = new VectorBoardAccess(state, { saveGame },
    () => ({ profileId: 'p', slotId: 's' }), () => busy, undefined, settled, undefined, opts.supply ? parseSupplyRules(vectorRules) : undefined);
  return { state, saveGame, settled, busy: () => { busy = true; } };
}
// Phase 6: the board shows the supply hand the round will use, from the pack pool.
it('the board opens with the supply hand and previews with it', async () => {
  setup({ supply: true });
  const view = await access.open();
  const supply = parseSupplyRules(vectorRules)!;
  expect(view.prepared.layout.tray).toEqual(supply.starter);
  expect(view.prepared.board.cards.filter(c => c.origin === 'supply').map(c => c.label.zh)).toEqual(supply.starter.map(id => supply.cards.find(c => c.id === id)!.name.zh));
  const placed = await view.preview({ placements: { '01': supply.starter[0] }, tray: [] });
  expect(placed.result.trace.some(e => e.owner?.id === supply.starter[0] && e.status === 'applied')).toBe(true);
});
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
  // The view's own save keeps it current: the player goes on arranging and saving without reopening.
  const moved = { placements: { ...view.prepared.layout.placements }, tray: view.prepared.layout.tray };
  await view.save(moved);
  expect(h.saveGame).toHaveBeenCalledTimes(2);
  expect(await view.preview(moved)).toBeTruthy();
  // A change from anywhere else still makes it stale.
  h.state.set(P.roundNumber, 9);
  await expect(view.save(moved)).rejects.toThrow('stale');
});
it('tells the table when a round is running, so a refused save waits for the round instead of being lost', async () => {
  const h = setup();
  expect(access.roundRunning()).toBe(false);
  const view = await access.open();
  h.busy();
  expect(access.roundRunning()).toBe(true);
  await expect(view.save(view.prepared.layout)).rejects.toThrow('stale');
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('tries the other board shape without saving it, and saves the shape with the arrangement', async () => {
  const h = setup();
  const view = await access.open();
  const visits = (p: { result: { trace: Array<{ eventType: string; cellId?: string }> } }) => p.result.trace.filter(e => e.eventType === 'visit').map(e => e.cellId);
  const ring = await view.preview(view.prepared.layout, 'ring');
  expect(visits(ring).slice(5, 8)).toEqual(['06', '01', '02']);
  expect(h.state.get<VectorState>(P.plotVector)?.shape).toBeUndefined();
  await view.save(view.prepared.layout, 'ring');
  expect(h.state.get<VectorState>(P.plotVector)?.shape).toBe('ring');
  // The view is current after its own save and now plays on the ring.
  expect(visits(await view.preview(view.prepared.layout)).slice(5, 8)).toEqual(['06', '01', '02']);
  await view.save(view.prepared.layout, 'line');
  expect(h.state.get<VectorState>(P.plotVector)?.shape).toBe('line');
});
it('writes the live tree with only the board state replaced, reading only the entries it needs', async () => {
  const h = setup();
  h.state.set('记忆.很大', Array.from({ length: 50 }, (_, i) => ({ i })));
  h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
  const view = await access.open();
  await view.save(view.prepared.layout);
  const written = h.saveGame.mock.calls[0][2] as Record<string, unknown>;
  const live = h.state.toSnapshot();
  expect(written).toEqual(live);
  expect((written as { 记忆: unknown }).记忆).toEqual(live.记忆);
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
it('a preview after the save changed is refused, never computed from the old snapshot', async () => {
  const h = setup(), view = await access.open();
  h.state.set(P.roundNumber, 9);
  await expect(view.preview(view.prepared.layout)).rejects.toThrow('stale');
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('a saved arrangement that no longer computes opens cleared; saving keeps it cleared and the next open is normal', async () => {
  const h = setup();
  h.state.set(P.plotVector, { ...initialVectorState(), layout: { placements: { '01': 'basic:push', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } });
  failing.placed = true;
  const view = await access.open();
  expect(view.cleared).toBe(true);
  expect(Object.entries(view.prepared.layout.placements).filter(([cell, id]) => cell !== '06' && id)).toEqual([]);
  expect(h.saveGame).not.toHaveBeenCalled(); // nothing is written until the player saves
  await expect(view.preview({ placements: { '01': 'basic:push' }, tray: [] })).rejects.toThrow('算不出来');
  await view.save(view.prepared.layout);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
  expect(Object.entries(h.state.get<VectorState>(P.plotVector)!.layout!.placements).filter(([cell, id]) => cell !== '06' && id)).toEqual([]);
  failing.placed = false;
  expect((await access.open()).cleared).toBe(false);
});
it('lists obtained entries whose ability is not ready; the player retry holds the board like a save and is refused during a round', async () => {
  const h = setup();
  h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
  const task = tasksAfterSave({ id: 'x', success: true, before: [], after: projectSavedElements(h.state.toSnapshot()).entries })[0];
  // A received reply that did not pass the one check.
  h.state.set(P.plotVector, { ...initialVectorState(), tasks: [{ task, status: 'failed', error: 'boom', raw: 'not an ability' }] });
  let busy = false, heldDuringRetry: boolean | undefined;
  const regenerate = vi.fn(async () => { heldDuringRetry = retryAccess.isSaving; return { bound: true, requested: true }; });
  const retryAccess: VectorBoardAccess = new VectorBoardAccess(h.state, { saveGame: h.saveGame },
    () => ({ profileId: 'p', slotId: 's' }), () => busy, undefined, () => {}, regenerate);
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
