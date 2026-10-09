import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEngineStateStore } from './engine-state';
import { StateManager } from '../core/state-manager';
import { RollbackSnapshot } from '../core/rollback-snapshot';
import { BehaviorRunner } from '../behaviors/behavior-runner';
import { NpcDedupModule } from '../behaviors/npc-dedup';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { NpcRecord } from '../social/npc-merge';

const F = DEFAULT_ENGINE_PATHS.npcFieldNames;
const REL = DEFAULT_ENGINE_PATHS.relationships;

describe('engine-state store — onGameLoad dispatch on real save load', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // loadGame 内部会同步 localStorage 设置 — jsdom 环境下保持默认即可
  });

  it('loadGame dispatches runOnGameLoad to the linked BehaviorRunner', () => {
    const store = useEngineStateStore();
    const stateManager = new StateManager();
    const runner = { runOnGameLoad: vi.fn() };

    store.linkStateManager(stateManager);
    store.linkBehaviorRunner(runner);
    store.loadGame({ 元数据: { 回合序号: 3 } }, 'tianming', 'p1', 's1');

    expect(runner.runOnGameLoad).toHaveBeenCalledTimes(1);
    expect(runner.runOnGameLoad).toHaveBeenCalledWith(stateManager);
  });

  it('loading a dirty save with duplicate NPCs heals it (real NpcDedupModule)', () => {
    const store = useEngineStateStore();
    const stateManager = new StateManager();
    const runner = new BehaviorRunner();
    runner.register(new NpcDedupModule(REL, F));

    store.linkStateManager(stateManager);
    store.linkBehaviorRunner(runner);

    // 模拟历史脏存档：同一角色两条，第一条带累积状态，第二条是字段更全的重复
    store.loadGame(
      {
        社交: {
          关系: [
            { [F.name]: '李明阳', [F.affinity]: 72, [F.memory]: ['旧记忆'] },
            { [F.name]: '李明阳', [F.affinity]: 50, [F.bodyDescription]: '身形高挑' },
            { [F.name]: '王五' },
          ],
        },
      },
      'tianming', 'p1', 's1',
    );

    const rel = stateManager.get<NpcRecord[]>(REL) ?? [];
    expect(rel).toHaveLength(2);
    expect(rel[0][F.name]).toBe('李明阳');
    expect(rel[0][F.affinity]).toBe(72); // 累积好感度保留
    expect(rel[0][F.bodyDescription]).toBe('身形高挑'); // 重复条目的增量字段融合进来
    expect(rel[1][F.name]).toBe('王五');
  });

  it('loadGame without a linked runner still works (no throw)', () => {
    const store = useEngineStateStore();
    const stateManager = new StateManager();
    store.linkStateManager(stateManager);
    expect(() => store.loadGame({}, 'tianming', 'p1', 's1')).not.toThrow();
  });
});

// 存档瘦身 D1A: the round-start snapshot is rebuilt from the save's rollback record on load.
describe('engine-state store — the rollback snapshot on load', () => {
  const P = DEFAULT_ENGINE_PATHS;
  beforeEach(() => { setActivePinia(createPinia()); });

  /** A save as a round leaves it: the record back to the round start in place of the marker. */
  function savedAfterARound(): Record<string, unknown> {
    const sm = new StateManager();
    sm.loadTree({ 元数据: { 回合序号: 4, 叙事历史: [] }, 角色: { 基础信息: { 当前位置: '长安' } } });
    const holder = new RollbackSnapshot(P);
    sm.set(P.rollbackPatch, holder.capture(sm.toSnapshot()), 'system');
    sm.set(P.roundNumber, 5, 'system');
    sm.set(P.playerLocation, '洛阳', 'command');
    return JSON.parse(JSON.stringify(holder.treeToSave(sm.liveTree()))) as Record<string, unknown>;
  }

  it('rebuilds the snapshot before the load-time hooks change the tree, and marks the tree', () => {
    const store = useEngineStateStore();
    const stateManager = new StateManager();
    const holder = new RollbackSnapshot(P);
    const seenByHooks: unknown[] = [];
    store.linkStateManager(stateManager);
    store.linkRollbackSnapshot(holder);
    store.linkBehaviorRunner({
      runOnGameLoad: (sm: StateManager) => {
        seenByHooks.push(sm.get(P.rollbackPatch));
        sm.set(P.playerLocation, '修复后的地点', 'system');
      },
    });

    store.loadGame(savedAfterARound(), 'tianming', 'p1', 's1');

    const marker = stateManager.get(P.rollbackPatch);
    expect(seenByHooks).toEqual([marker]);
    const snapshot = holder.get(marker) as { 元数据: { 回合序号: number }; 角色: { 基础信息: { 当前位置: string } } };
    expect(snapshot.元数据.回合序号).toBe(4);
    expect(snapshot.角色.基础信息.当前位置).toBe('长安');
  });

  it('closing the game lets go of the held snapshot', () => {
    const store = useEngineStateStore();
    const stateManager = new StateManager();
    const holder = new RollbackSnapshot(P);
    store.linkStateManager(stateManager);
    store.linkRollbackSnapshot(holder);
    store.loadGame(savedAfterARound(), 'tianming', 'p1', 's1');
    expect(holder.current()).toBeDefined();
    store.clearGame();
    expect(holder.current()).toBeUndefined();
  });
});
