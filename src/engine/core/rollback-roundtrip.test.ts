import 'fake-indexeddb/auto';
/**
 * 存档瘦身 D1A, S2: a rollback gives back exactly what the old whole snapshot gave back — right after the round, after
 * the save is loaded again (a refresh), and after the save went through JSON (an export and import, a cloud copy).
 *
 * Real StateManager, PreProcessStage, RollbackSnapshot, SaveManager on the real IndexedDB adapter (fake-indexeddb),
 * the engine-state store's loadGame and the orchestrator's own rollback method. The expected tree is what the old
 * PreProcess stored: the tree at round start without its rollback data.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { cloneDeep } from 'lodash-es';
import { StateManager } from './state-manager';
import { RollbackSnapshot } from './rollback-snapshot';
import { GameOrchestrator } from './game-orchestrator';
import { PreProcessStage } from '../pipeline/stages/pre-process';
import { DEFAULT_ENGINE_PATHS, type PipelineContext } from '../pipeline/types';
import { SaveManager } from '../persistence/save-manager';
import { idbAdapter } from '../persistence/idb-adapter';
import { useEngineStateStore } from '../stores/engine-state';
import type { ProfileManager } from '../persistence/profile-manager';
import type { GameStateTree, SaveSlotMeta } from '../types';

const P = DEFAULT_ENGINE_PATHS;
type Json = Record<string, unknown>;

function startingTree(): Json {
  return {
    元数据: { 回合序号: 0, 叙事历史: [] },
    角色: {
      基础信息: { 姓名: '主角', 当前位置: '长安' },
      背包: { 药水: { 数量: 2 }, 长剑: { 数量: 1 } },
      效果: [{ 名称: '疲惫', 剩余回合: 2 }],
    },
    社交: {
      关系: [{ 名称: '林婉儿', 好感度: 10, 记忆: ['初遇'] }, { 名称: '关宇', 好感度: 0, 记忆: [] }],
      事件: { 事件记录: [] },
    },
    // A field holding undefined: kept by IndexedDB, dropped by JSON.
    系统: { 扩展: { image: { tasks: [{ id: 't1', negative: undefined, status: 'done' }] } } },
  };
}

/** A round's changes, made as commands make them. */
function playRound(sm: StateManager, n: number): void {
  sm.push(P.narrativeHistory, { role: 'user', content: `输入${n}` }, 'system');
  sm.push(P.narrativeHistory, { role: 'assistant', content: `正文${n}`, _delta: [] }, 'system');
  sm.push('社交.事件.事件记录', { 事件名称: `事件${n}` }, 'command');
  sm.set('角色.基础信息.当前位置', `地点${n}`, 'command');
  sm.add('社交.关系[名称=林婉儿].好感度', 5, 'command');
  sm.push('社交.关系[名称=林婉儿].记忆', `第${n}回合`, 'command');
  // A key removed and added back moves to the end; a list loses an entry; a new branch appears.
  sm.delete('角色.背包.药水', 'command');
  sm.set('角色.背包.药水', { 数量: 2 - (n % 2) }, 'command');
  sm.pull('角色.效果', { 名称: '疲惫', 剩余回合: 2 }, 'command');
  sm.set(`角色.称号${n}`, { 来源: `第${n}回合` }, 'command');
  sm.push('系统.扩展.image.tasks', { id: `t${n + 1}`, negative: undefined, status: 'queued' }, 'system');
}

/** What the old PreProcess stored: the tree at round start without its rollback data. */
function oldWholeSnapshot(sm: StateManager): Json {
  const tree = sm.toSnapshot();
  delete (tree.元数据 as Json)[P.preRoundSnapshot.split('.')[1]];
  delete ((tree.系统 as Json).扩展 as Json).rollbackPatch;
  return tree;
}

function profileStub(): ProfileManager {
  const meta: Record<string, SaveSlotMeta> = {};
  return {
    updateSlotMeta: async (_p: string, s: string, update: Partial<SaveSlotMeta>) => { meta[s] = { ...meta[s], ...update } as SaveSlotMeta; },
    getSlotMeta: (_p: string, s: string) => meta[s],
  } as unknown as ProfileManager;
}

/** The orchestrator's own rollback method, on a host holding only what it reads. */
function rollbackWith(sm: StateManager, holder: RollbackSnapshot): void {
  const host = Object.assign(Object.create(GameOrchestrator.prototype) as object, {
    _paths: P, rollbackSnapshot: holder, abortController: null, _subPipelineActive: false, requestedSaveActive: false,
    subPipelines: {}, pendingSave: null, stateRevision: 0, _getActiveSlot: () => null,
    ports: { actionQueue: { consumeActions: () => [] } },
    memoryManager: { clearConfigCache: () => {} }, engramManager: { isEnabled: () => false },
  }) as unknown as { rollbackLastRound: (s: StateManager) => void };
  host.rollbackLastRound(sm);
}

/** A page: its own state, holder, PreProcess and SaveManager (wired as bootstrap wires them). */
function page() {
  const sm = new StateManager();
  const holder = new RollbackSnapshot(P);
  const saves = new SaveManager(profileStub());
  saves.setTreeToSave((tree) => holder.treeToSave(tree));
  const store = useEngineStateStore();
  store.linkStateManager(sm);
  store.linkRollbackSnapshot(holder);
  const preProcess = new PreProcessStage(sm, { consumeActions: () => [] }, P, holder);
  return { sm, holder, saves, store, preProcess };
}

const ctx = (): PipelineContext => ({ userInput: '', actionQueuePrompt: '', stateSnapshot: {}, chatHistory: [], messages: [], roundNumber: 0, meta: {} }) as unknown as PipelineContext;

describe('rollback round trip (存档瘦身 D1A, S2)', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    vi.spyOn(console, 'info').mockImplementation(() => {});
    await idbAdapter.delete('save_p_s');
  });

  it('gives back the old whole snapshot: right away, after a reload, and after the save went through JSON', async () => {
    const first = page();
    first.store.loadGame(startingTree(), 'tianming', 'p', 's');
    let expected: Json = {};
    for (let n = 1; n <= 3; n++) {
      expected = oldWholeSnapshot(first.sm);
      await first.preProcess.execute(ctx());
      playRound(first.sm, n);
      // Saves happen mid-round too (a sub-flow, a panel edit): each stores a record for the tree as it is then.
      await first.saves.saveGame('p', 's', first.sm.liveTree());
    }
    const stored = (await idbAdapter.get<GameStateTree>('save_p_s'))!;
    expect(stored.元数据).not.toHaveProperty('上次对话前快照');
    expect(((stored.系统 as Json).扩展 as Json).rollbackPatch).toMatchObject({ format: 1, base: { round: 3, historyLength: 6 } });

    // (a) In the same session.
    const now = cloneDeep(first.sm.liveTree());
    rollbackWith(first.sm, first.holder);
    expect(JSON.stringify(first.sm.liveTree())).toBe(JSON.stringify(expected));
    first.sm.loadTree(now);

    // (b) After a reload: another page loads the save.
    const second = page();
    second.store.loadGame((await second.saves.loadGame('p', 's'))!, 'tianming', 'p', 's');
    rollbackWith(second.sm, second.holder);
    expect(second.sm.liveTree()).toStrictEqual(expected);

    // (c) After an export and import (JSON drops the fields holding undefined).
    const viaJson = JSON.parse(JSON.stringify(stored)) as GameStateTree;
    await idbAdapter.set('save_p_s', viaJson);
    const third = page();
    third.store.loadGame((await third.saves.loadGame('p', 's'))!, 'tianming', 'p', 's');
    rollbackWith(third.sm, third.holder);
    expect(third.sm.liveTree()).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it('rolls back once per round: after the rollback is saved and loaded again there is nothing to roll back to', async () => {
    const first = page();
    first.store.loadGame(startingTree(), 'tianming', 'p', 's');
    await first.preProcess.execute(ctx());
    playRound(first.sm, 1);
    rollbackWith(first.sm, first.holder);
    await first.saves.saveGame('p', 's', first.sm.liveTree());

    const second = page();
    second.store.loadGame((await second.saves.loadGame('p', 's'))!, 'tianming', 'p', 's');
    expect(second.sm.get(P.rollbackPatch)).toBeUndefined();
    const toasts: unknown[] = [];
    const { eventBus } = await import('./event-bus');
    const off = eventBus.on('ui:toast', (t) => { toasts.push(t); });
    try {
      rollbackWith(second.sm, second.holder);
    } finally { off(); }
    expect(toasts).toMatchObject([{ i18nKey: 'engine.toast.noRollbackSnapshot' }]);
    expect(second.sm.get(P.roundNumber)).toBe(0);
  });

  it('a save made while the round is still running holds the record for that moment; the next save replaces it', async () => {
    const first = page();
    first.store.loadGame(startingTree(), 'tianming', 'p', 's');
    const expected = oldWholeSnapshot(first.sm);
    await first.preProcess.execute(ctx());
    await first.saves.saveGame('p', 's', first.sm.liveTree());
    const early = (await idbAdapter.get<GameStateTree>('save_p_s'))!;
    expect(((early.系统 as Json).扩展 as Json).rollbackPatch).toMatchObject({ base: { round: 1, historyLength: 0 } });
    playRound(first.sm, 1);
    await first.saves.saveGame('p', 's', first.sm.liveTree());

    const second = page();
    second.store.loadGame((await second.saves.loadGame('p', 's'))!, 'tianming', 'p', 's');
    rollbackWith(second.sm, second.holder);
    expect(second.sm.liveTree()).toStrictEqual(expected);
  });
});
