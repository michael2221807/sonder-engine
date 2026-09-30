import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { StateManager } from '../../engine/core/state-manager';
import { DEFAULT_ENGINE_PATHS as P } from '../../engine/pipeline/types';
import { writePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { eventBus } from '../../engine/core/event-bus';
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
  const hasSave = vi.fn(async () => true);
  const settled = vi.fn(() => { expect(access.isSaving).toBe(false); });
  let slot: { profileId: string; slotId: string } | null = { profileId: 'p', slotId: 's' };
  access = new VectorBoardAccess(state, { saveGame, hasSave },
    () => slot, () => busy, undefined, settled, undefined, opts.supply ? parseSupplyRules(vectorRules) : undefined);
  return { state, saveGame, hasSave, settled, busy: () => { busy = true; },
    activate: (next: { profileId: string; slotId: string } | null) => { slot = next; } };
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
it('preview uses the next round seed; a commit keeps the arrangement live and only persist writes the save, once', async () => {
  const h = setup(), before = h.state.get<VectorState>(P.plotVector)!;
  const view = await access.open();
  expect(view.prepared.id).toBe('p/s/8');
  await view.preview(view.prepared.layout);
  await view.commit(view.prepared.layout);
  // PO 2026-09-30 B: while the table is open, only the live state changes.
  expect(h.saveGame).not.toHaveBeenCalled();
  expect(h.state.get(P.plotVector)).toEqual({ ...before, layout: view.prepared.layout });
  expect(access.hasUnsaved).toBe(true);
  // The view's own commit keeps it current: the player goes on arranging without reopening.
  const moved = { placements: { ...view.prepared.layout.placements }, tray: view.prepared.layout.tray };
  await view.commit(moved);
  expect(await view.preview(moved)).toBeTruthy();
  expect(h.saveGame).not.toHaveBeenCalled();
  // Closing the table writes the save file once; nothing is left to write after it.
  expect(await access.persist()).toBe(true);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
  expect(h.settled).toHaveBeenCalledTimes(1);
  expect(access.hasUnsaved).toBe(false);
  expect(await access.persist()).toBe(true);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
  // A change from anywhere else still makes the view stale.
  h.state.set(P.roundNumber, 9);
  await expect(view.commit(moved)).rejects.toThrow('stale');
});
it('tells the table when a round is running: a refused commit waits for the round, and nothing is written meanwhile', async () => {
  const h = setup();
  expect(access.roundRunning()).toBe(false);
  const view = await access.open();
  await view.commit(view.prepared.layout);
  h.busy();
  expect(access.roundRunning()).toBe(true);
  await expect(view.commit(view.prepared.layout)).rejects.toThrow('stale');
  // The round saves the whole state itself; the table writes after the round if anything is still waiting.
  expect(await access.persist()).toBe(false);
  expect(h.saveGame).not.toHaveBeenCalled();
  expect(access.hasUnsaved).toBe(true);
});
it('tries the other board shape without keeping it, and keeps the shape with the arrangement', async () => {
  const h = setup();
  const view = await access.open();
  const visits = (p: { result: { trace: Array<{ eventType: string; cellId?: string }> } }) => p.result.trace.filter(e => e.eventType === 'visit').map(e => e.cellId);
  const ring = await view.preview(view.prepared.layout, 'ring');
  expect(visits(ring).slice(5, 8)).toEqual(['06', '01', '02']);
  expect(h.state.get<VectorState>(P.plotVector)?.shape).toBeUndefined();
  await view.commit(view.prepared.layout, 'ring');
  expect(h.state.get<VectorState>(P.plotVector)?.shape).toBe('ring');
  // The view is current after its own commit and now plays on the ring.
  expect(visits(await view.preview(view.prepared.layout)).slice(5, 8)).toEqual(['06', '01', '02']);
  await view.commit(view.prepared.layout, 'line');
  expect(h.state.get<VectorState>(P.plotVector)?.shape).toBe('line');
  await access.persist();
  expect((h.saveGame.mock.calls[0][2] as { 系统: { 扩展: { plotVector: VectorState } } }).系统.扩展.plotVector.shape).toBe('line');
});
it('persist writes the live tree with only the board branch new, reading only the entries it needs', async () => {
  const h = setup();
  h.state.set('记忆.很大', Array.from({ length: 50 }, (_, i) => ({ i })));
  h.state.set(P.inventoryItems, { tea: { 名称: '茶', 数量: 1 } });
  const view = await access.open();
  await view.commit(view.prepared.layout);
  await access.persist();
  const written = h.saveGame.mock.calls[0][2] as Record<string, unknown>;
  const live = h.state.toSnapshot();
  expect(written).toEqual(live);
  expect((written as { 记忆: unknown }).记忆).toEqual(live.记忆);
});
it.each(['busy', 'load', 'changed', 'off'] as const)('rejects a stale draft after %s without changing anything', async reason => {
  const h = setup(), view = await access.open();
  if (reason === 'busy') h.busy();
  if (reason === 'load') h.state.loadTree(h.state.toSnapshot());
  if (reason === 'changed') h.state.set(P.roundNumber, 9);
  if (reason === 'off') writePlotVectorControl(false);
  const before = h.state.toSnapshot();
  // A loaded tree is another tree: the table drops its draft instead of carrying it over.
  await expect(view.commit(view.prepared.layout)).rejects.toThrow(reason === 'load' ? 'switched' : 'stale');
  expect(h.state.toSnapshot()).toEqual(before);
  expect(access.hasUnsaved).toBe(false);
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('a failed write keeps the arrangement live and waiting, and reports the failure', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout);
  h.saveGame.mockRejectedValueOnce(new Error('transaction aborted'));
  await expect(access.persist()).rejects.toThrow('transaction aborted');
  expect(h.settled).toHaveBeenCalledTimes(1);
  expect(h.state.get<VectorState>(P.plotVector)?.layout).toEqual(view.prepared.layout);
  expect(access.hasUnsaved).toBe(true);
  expect(await access.persist()).toBe(true);
  expect(access.hasUnsaved).toBe(false);
});
it('a slot details failure after the data write still counts as written', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout);
  h.saveGame.mockImplementationOnce(async (_p, _s, _tree, _meta, commit) => { commit?.guard(); commit?.committed(); throw new Error('metadata'); });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await access.persist()).toBe(true);
  expect(access.hasUnsaved).toBe(false);
});
/** Let the access settle a replaced tree (it looks once the loader has named the new save). */
const settled = () => new Promise(resolve => setTimeout(resolve, 0));
it('another save loaded before the write: at that moment the kept tree goes to its own save, never to the new one', async () => {
  const h = setup(), view = await access.open();
  const layout = { placements: { ...view.prepared.layout.placements }, tray: view.prepared.layout.tray };
  await view.commit(layout, 'ring');
  // The save page loads another slot: the tree is replaced, then the store names the new save.
  h.state.loadTree({ otherSlot: true });
  h.activate({ profileId: 'p', slotId: 'other' });
  await settled();
  expect(h.saveGame).toHaveBeenCalledTimes(1);
  const [profileId, slotId, tree] = h.saveGame.mock.calls[0] as [string, string, { 系统: { 扩展: { plotVector: VectorState } } }];
  expect([profileId, slotId]).toEqual(['p', 's']);
  expect(tree.系统.扩展.plotVector.shape).toBe('ring');
  expect(h.state.toSnapshot()).toEqual({ otherSlot: true });
  expect(access.hasUnsaved).toBe(false);
  expect(await access.persist()).toBe(true);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
  // A view of the old tree cannot keep anything any more.
  await expect(view.commit(layout)).rejects.toThrow('switched');
});
it('an old tree is never written later: a save restored or synced after the switch keeps what it got', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout, 'ring');
  // The switch happens while the old save is missing (being replaced by a restore), so nothing is written then...
  h.hasSave.mockResolvedValueOnce(false);
  h.state.loadTree({ otherSlot: true });
  h.activate({ profileId: 'p', slotId: 'other' });
  await settled();
  // ...and after the restore wrote it, no later trigger writes the old tree over it.
  expect(await access.persist()).toBe(true);
  expect(h.saveGame).not.toHaveBeenCalled();
  expect(access.hasUnsaved).toBe(false);
});
it('the game closed before the arrangement was written: nothing old is written later', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout, 'ring');
  h.state.clear();
  h.activate(null);
  expect(await access.persist()).toBe(true);
  expect(h.saveGame).not.toHaveBeenCalled();
  expect(access.hasUnsaved).toBe(false);
});
it('a save deleted meanwhile is never written back', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout);
  h.hasSave.mockResolvedValue(false);
  h.state.loadTree({ otherSlot: true });
  h.activate({ profileId: 'p', slotId: 'other' });
  await settled();
  expect(h.saveGame).not.toHaveBeenCalled();
  expect(access.hasUnsaved).toBe(false);
});
it('the same save loaded again (or a round rolled back) is that save\'s truth: nothing old is written over it', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout, 'ring');
  h.state.loadTree(h.state.toSnapshot());
  await settled();
  expect(h.saveGame).not.toHaveBeenCalled();
  expect(access.hasUnsaved).toBe(false);
  expect(await access.persist()).toBe(true);
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('another save of the same slot (a round, a retry) carries the arrangement: nothing is left to write', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout);
  eventBus.emit('engine:save-complete', { profileId: 'p', slotId: 'other' });
  expect(access.hasUnsaved).toBe(true);
  eventBus.emit('engine:save-complete', { profileId: 'p', slotId: 's' });
  expect(access.hasUnsaved).toBe(false);
  await access.persist();
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('two closings in a row write once: the second waits for the first', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout);
  let release!: () => void;
  h.saveGame.mockImplementationOnce(async (_p, _s, _tree, _meta, commit) => {
    await new Promise<void>(resolve => { release = resolve; });
    commit?.guard(); commit?.committed();
  });
  const first = access.persist(), second = access.persist();
  await Promise.resolve();
  release();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(h.saveGame).toHaveBeenCalledTimes(1);
});
it('a move kept while the save is being written is written next time', async () => {
  const h = setup(), view = await access.open();
  await view.commit(view.prepared.layout);
  h.saveGame.mockImplementationOnce(async (_p, _s, _tree, _meta, commit) => {
    await view.commit(view.prepared.layout, 'ring');
    commit?.guard(); commit?.committed();
  });
  await access.persist();
  expect(access.hasUnsaved).toBe(true);
  await access.persist();
  expect(h.saveGame).toHaveBeenCalledTimes(2);
  expect((h.saveGame.mock.calls[1][2] as { 系统: { 扩展: { plotVector: VectorState } } }).系统.扩展.plotVector.shape).toBe('ring');
  expect(access.hasUnsaved).toBe(false);
});
it('a preview after the save changed is refused, never computed from the old snapshot', async () => {
  const h = setup(), view = await access.open();
  h.state.set(P.roundNumber, 9);
  await expect(view.preview(view.prepared.layout)).rejects.toThrow('stale');
  expect(h.saveGame).not.toHaveBeenCalled();
});
it('a saved arrangement that no longer computes opens cleared; keeping it keeps it cleared and the next open is normal', async () => {
  const h = setup();
  h.state.set(P.plotVector, { ...initialVectorState(), layout: { placements: { '01': 'basic:push', '02': null, '03': null, '04': null, '05': null, '06': null }, tray: [] } });
  failing.placed = true;
  const view = await access.open();
  expect(view.cleared).toBe(true);
  expect(Object.entries(view.prepared.layout.placements).filter(([cell, id]) => cell !== '06' && id)).toEqual([]);
  expect(h.saveGame).not.toHaveBeenCalled(); // nothing is written until the table closes
  await expect(view.preview({ placements: { '01': 'basic:push' }, tray: [] })).rejects.toThrow('算不出来');
  await view.commit(view.prepared.layout);
  expect(Object.entries(h.state.get<VectorState>(P.plotVector)!.layout!.placements).filter(([cell, id]) => cell !== '06' && id)).toEqual([]);
  await access.persist();
  expect(h.saveGame).toHaveBeenCalledTimes(1);
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
  const retryAccess: VectorBoardAccess = new VectorBoardAccess(h.state, { saveGame: h.saveGame, hasSave: h.hasSave },
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
