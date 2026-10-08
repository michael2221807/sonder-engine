import { describe, it, expect, vi } from 'vitest';
import { GameOrchestrator } from './game-orchestrator';
import { eventBus } from './event-bus';

vi.mock('../stores/engine-action-queue', () => ({ useActionQueueStore: () => ({ consumeActions: () => [] }) }));

// Exercise the actual host save method with injected persistence, not an alternate implementation.
function harness() {
  let slot = { profileId: 'p', slotId: 'a' }, round = 89;
  const save = vi.fn(async (_p: string, _s: string, _tree: unknown, _meta: unknown,
    commit: { guard: () => void; committed: () => void }) => { commit.guard(); commit.committed(); });
  const host = Object.create(GameOrchestrator.prototype) as {
    abortController: AbortController | null; _subPipelineActive: boolean; requestedSaveActive: boolean;
    stateRevision: number; pendingSave: typeof slot | null; subPipelines: object;
    _getActiveSlot: () => typeof slot; _stateManager: { liveTree: () => unknown };
    _saveManager: { saveGame: typeof save }; flushRequestedSave: () => Promise<void>;
  };
  Object.assign(host, { abortController: null, _subPipelineActive: false, requestedSaveActive: false,
    stateRevision: 0, pendingSave: null, subPipelines: {}, _getActiveSlot: () => slot,
    ports: { actionQueue: { consumeActions: () => [] } }, // R5 step 4: the host reads stores through ports
    _stateManager: { liveTree: () => ({ round }) }, _saveManager: { saveGame: save } });
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

// PO D6 (2026-09-26): a rollback is written at once, so a reload does not bring the undone round back.
describe('rollback saves the restored round', () => {
  function rollbackHarness(tree: Record<string, unknown>) {
    const h = harness();
    let live = tree;
    // Like StateManager.rollbackTo: restore, then announce a 'rollback' change (the orchestrator bumps its revision).
    const sm = {
      get: (path: string) => path === '元数据.上次对话前快照' ? (live.元数据 as Record<string, unknown> | undefined)?.上次对话前快照 : undefined,
      rollbackTo: (snapshot: Record<string, unknown>) => { live = structuredClone(snapshot); eventBus.emit('engine:state-changed', { type: 'rollback' }); },
    };
    Object.assign(h.host, { _stateManager: { liveTree: () => live }, memoryManager: { clearConfigCache: () => {} },
      engramManager: { isEnabled: () => false }, unsubscribers: [] as Array<() => void> });
    // The orchestrator's own listeners: the rollback request and the revision bump on state changes.
    const host = h.host as unknown as { subscribeToEvents: (s: typeof sm) => void; unsubscribers: Array<() => void>; rollbackLastRound: (s: typeof sm) => void };
    host.subscribeToEvents(sm);
    return { ...h, rollback: () => host.rollbackLastRound(sm), dispose: () => host.unsubscribers.splice(0).forEach(off => off()) };
  }

  it('the rollback request saves the tree as it was before the round, once, after the revision moved', async () => {
    const h = rollbackHarness({ 元数据: { 回合序号: 90, 上次对话前快照: { 元数据: { 回合序号: 89 } } } });
    const seen: string[] = [];
    const offs = [eventBus.on('engine:rollback-complete', () => { seen.push('complete'); }),
      eventBus.on('engine:save-error', () => { seen.push('save-error'); })];
    try {
      eventBus.emit('engine:rollback-requested', undefined);
      await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
      expect(h.save.mock.calls[0].slice(0, 3)).toEqual(['p', 'a', { 元数据: { 回合序号: 89 } }]);
      expect(h.host.stateRevision).toBe(1);   // bumped by the rollback before the save took its revision
      expect(seen).toEqual(['complete']);     // the save's guard passed
    } finally { offs.forEach(off => off()); h.dispose(); }
  });

  // PO 2026-10-03: a setting changed after the round began survives undoing the round (the real StateManager).
  const before = {
    系统: { 设置: { prompt: { wordCountRequirement: 650, enableActionOptions: true } }, actionOptions: { mode: 'action', pace: 'fast' },
      扩展: { plotVector: { round: 'before' }, image: { enabled: false, config: { autoSceneOnRound: false }, characterAnchors: ['before'] } } },
    世界: { 状态: { 心跳: { 配置: { enabled: false, period: 5 }, 历史: ['before'] } } },
    元数据: { 回合序号: 89 },
  };
  const now = {
    系统: { 设置: { prompt: { wordCountRequirement: 2500, enableActionOptions: false } }, actionOptions: { mode: 'story', pace: 'slow' },
      扩展: { plotVector: { round: 'after' }, image: { enabled: true, config: { autoSceneOnRound: true }, characterAnchors: ['after'] } } },
    世界: { 状态: { 心跳: { 配置: { enabled: true, period: 3 }, 历史: ['after'] } } },
    元数据: { 回合序号: 90, 上次对话前快照: before },
  };
  const at = (tree: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], tree);
  /** The settings as they are now; the story (round, vector state, heartbeat history, image anchors) as before. */
  function expectSettingsKeptStoryBack(tree: unknown): void {
    expect(at(tree, '元数据.回合序号')).toBe(89);
    expect(at(tree, '系统.扩展.plotVector')).toEqual({ round: 'before' });
    expect(at(tree, '世界.状态.心跳.历史')).toEqual(['before']);
    expect(at(tree, '系统.扩展.image.characterAnchors')).toEqual(['before']);
    expect(at(tree, '系统.设置.prompt')).toEqual({ wordCountRequirement: 2500, enableActionOptions: false });
    expect(at(tree, '系统.actionOptions')).toEqual({ mode: 'story', pace: 'slow' });
    expect(at(tree, '世界.状态.心跳.配置')).toEqual({ enabled: true, period: 3 });
    expect(at(tree, '系统.扩展.image.enabled')).toBe(true);
    expect(at(tree, '系统.扩展.image.config')).toEqual({ autoSceneOnRound: true });
  }

  it('undoing a round keeps the player\'s settings as they are now: the story goes back, the settings do not', async () => {
    const { StateManager } = await import('./state-manager');
    const sm = new StateManager();
    sm.loadTree(structuredClone(now));
    const h = harness();
    Object.assign(h.host, { _stateManager: sm, memoryManager: { clearConfigCache: () => {} },
      engramManager: { isEnabled: () => false }, unsubscribers: [] as Array<() => void> });
    const host = h.host as unknown as { subscribeToEvents: (s: typeof sm) => void; unsubscribers: Array<() => void>; rollbackLastRound: (s: typeof sm) => void };
    host.subscribeToEvents(sm);
    try {
      host.rollbackLastRound(sm);
      await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
      expectSettingsKeptStoryBack(h.save.mock.calls[0][2]);
    } finally { host.unsubscribers.splice(0).forEach(off => off()); }
  });

  it('a round that fails goes back the same way: settings changed while it ran stay', async () => {
    const { StateManager } = await import('./state-manager');
    const { DEFAULT_ENGINE_PATHS: P } = await import('../pipeline/types');
    const sm = new StateManager();
    sm.loadTree(structuredClone(before));
    const h = harness();
    const errors: unknown[] = [];
    const off = eventBus.on('ai:error', (payload) => { errors.push(payload); });
    Object.assign(h.host, {
      _stateManager: sm, _paths: P, subPipelines: {},
      memoryManager: { clearConfigCache: () => {} }, engramManager: { isEnabled: () => false },
      runner: { run: async () => {
        // As PreProcess does: the snapshot first, then the round moves on and the story changes.
        sm.set(P.preRoundSnapshot, sm.toSnapshot(), 'system');
        for (const path of ['元数据.回合序号', '系统.扩展.plotVector', '世界.状态.心跳.历史', '系统.扩展.image.characterAnchors'])
          sm.set(path, structuredClone(at(now, path)), 'system');
        // Meanwhile the player changes settings; then the model call fails.
        for (const path of ['系统.设置.prompt', '系统.actionOptions', '世界.状态.心跳.配置', '系统.扩展.image.enabled', '系统.扩展.image.config'])
          sm.set(path, structuredClone(at(now, path)), 'user');
        throw new Error('model down');
      } },
    });
    try {
      await (h.host as unknown as { runRound: (text: string, s: typeof sm) => Promise<void> }).runRound('go', sm);
    } finally { off(); }
    expect(errors).toHaveLength(1);
    expectSettingsKeptStoryBack(sm.liveTree());
  });

  it('writes nothing when there is no snapshot or a round is still running', async () => {
    const none = rollbackHarness({ 元数据: { 回合序号: 90 } });
    const busy = rollbackHarness({ 元数据: { 回合序号: 90, 上次对话前快照: { 元数据: { 回合序号: 89 } } } });
    try {
      none.rollback();
      busy.host.abortController = new AbortController();
      busy.rollback();
      await new Promise((r) => setTimeout(r, 0));
      expect(none.save).not.toHaveBeenCalled();
      expect(busy.save).not.toHaveBeenCalled();
    } finally { none.dispose(); busy.dispose(); }
  });
});
