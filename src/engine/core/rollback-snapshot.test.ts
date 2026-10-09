import { describe, it, expect, vi, afterEach } from 'vitest';
import { cloneDeep } from 'lodash-es';
import { RollbackSnapshot, ROLLBACK_MARKER_PREFIX } from './rollback-snapshot';
import { StateManager } from './state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { isRollbackPatchRecord } from '../persistence/save-format/rollback-patch';
import type { GameStateTree } from '../types';

const P = DEFAULT_ENGINE_PATHS;
type Json = Record<string, unknown>;

/** A small game: two rounds of history, a list and an object that a round changes. */
function game(round = 3): Json {
  return {
    元数据: { 回合序号: round, 叙事历史: [{ role: 'user', content: '一' }, { role: 'assistant', content: '甲' }] },
    角色: { 背包: { 药水: 2, 长剑: 1 }, 基础信息: { 当前位置: '长安' } },
    社交: { 事件: { 事件记录: [{ 事件名称: '初遇' }] } },
    系统: { 扩展: { image: { enabled: false } } },
  };
}

/** What a round does after PreProcess: the round number moves on, entries and events are added, a field changes. */
function playRound(sm: StateManager): void {
  sm.set(P.roundNumber, (sm.get<number>(P.roundNumber) ?? 0) + 1, 'system');
  sm.push(P.narrativeHistory, { role: 'user', content: '二' }, 'system');
  sm.push(P.narrativeHistory, { role: 'assistant', content: '乙' }, 'system');
  sm.push('社交.事件.事件记录', { 事件名称: '再遇' }, 'command');
  sm.set('角色.背包.药水', 1, 'command');
  sm.set('角色.基础信息.当前位置', '洛阳', 'command');
}

/** PreProcess, as the stage does it: the snapshot to the holder, the marker into the tree. */
function roundStart(sm: StateManager, holder: RollbackSnapshot): string {
  const marker = holder.capture(sm.toSnapshot());
  sm.set(P.rollbackPatch, marker, 'system');
  return marker;
}

describe('RollbackSnapshot', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('holds a snapshot without rollback data and names it by a marker of its own', () => {
    const holder = new RollbackSnapshot(P);
    const tree = { ...game(), 元数据: { ...(game().元数据 as Json), 上次对话前快照: { old: true } }, 系统: { 扩展: { rollbackPatch: 'round-start:9' } } };
    const first = holder.capture(tree);
    expect(first.startsWith(ROLLBACK_MARKER_PREFIX)).toBe(true);
    const held = holder.get(first) as Json;
    expect((held.元数据 as Json).上次对话前快照).toBeUndefined();
    expect((held.系统 as { 扩展: Json }).扩展).toEqual({});
    expect(tree.系统.扩展.rollbackPatch).toBe('round-start:9');
    const second = holder.capture(game(4));
    expect(second).not.toBe(first);
    expect(holder.get(first)).toBeUndefined();
    expect(holder.get(second)).toEqual(game(4));
    expect(holder.get(undefined)).toBeUndefined();
    expect(holder.get({ marker: second })).toBeUndefined();
    holder.clear();
    expect(holder.get(second)).toBeUndefined();
  });

  it('gives back what it held for a flow that later brings back the tree carrying that marker', () => {
    const holder = new RollbackSnapshot(P);
    const marker = holder.capture(game(3));
    const kept = holder.current();
    holder.capture(game(4));
    expect(holder.get(marker)).toBeUndefined();
    holder.hold(kept!);
    expect(holder.get(marker)).toEqual(game(3));
  });

  it('turns a marker naming the held snapshot into the record when a tree is saved, copying only the way to it', () => {
    const sm = new StateManager();
    sm.loadTree(game());
    const holder = new RollbackSnapshot(P);
    roundStart(sm, holder);
    playRound(sm);
    const live = sm.liveTree();
    const written = holder.treeToSave(live);
    expect(written).not.toBe(live);
    expect(written.角色).toBe(live.角色);
    expect((written.系统 as Json).扩展).not.toBe((live.系统 as Json).扩展);
    expect(((written.系统 as { 扩展: Json }).扩展).image).toBe(((live.系统 as { 扩展: Json }).扩展).image);
    const record = (written.系统 as { 扩展: Json }).扩展.rollbackPatch;
    expect(isRollbackPatchRecord(record)).toBe(true);
    expect(record).toMatchObject({ base: { round: 4, historyLength: 4 } });
    // The live tree keeps its marker.
    expect(sm.get(P.rollbackPatch)).toMatch(ROLLBACK_MARKER_PREFIX);
  });

  it('finds the snapshot for a copy of the tree too (a manual save, a save to another slot)', () => {
    const sm = new StateManager();
    sm.loadTree(game());
    const holder = new RollbackSnapshot(P);
    roundStart(sm, holder);
    playRound(sm);
    const copy = JSON.parse(JSON.stringify(sm.liveTree())) as GameStateTree;
    expect(isRollbackPatchRecord((holder.treeToSave(copy).系统 as { 扩展: Json }).扩展.rollbackPatch)).toBe(true);
  });

  it('takes out a marker that names nothing held, and writes a tree without one as it is', () => {
    const holder = new RollbackSnapshot(P);
    holder.capture(game());
    const stale = { ...game(), 系统: { 扩展: { image: { enabled: false }, rollbackPatch: 'round-start:99' } } };
    expect(holder.treeToSave(stale)).toEqual(game());
    const plain = game();
    expect(holder.treeToSave(plain)).toBe(plain);
    const restoredElsewhere = { ...game(), 系统: { 扩展: { rollbackPatch: { format: 1, ops: [], base: { round: 3, historyLength: 2 } } } } };
    expect(holder.treeToSave(restoredElsewhere)).toBe(restoredElsewhere);
  });

  it('saves the tree without the record, and says so, when the record cannot be made', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const holder = new RollbackSnapshot(P);
    const marker = holder.capture(game());
    vi.spyOn(holder, 'patchFor').mockImplementation(() => { throw new Error('cannot diff'); });
    const written = holder.treeToSave({ ...game(), 系统: { 扩展: { rollbackPatch: marker } } });
    expect(readMarker(written)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('rebuilds on load the snapshot the stored record leads back to, before anything changes the tree', () => {
    const sm = new StateManager();
    sm.loadTree(game());
    const holder = new RollbackSnapshot(P);
    roundStart(sm, holder);
    const atRoundStart = cloneDeep(holder.get(sm.get(P.rollbackPatch)));
    playRound(sm);
    const stored = JSON.parse(JSON.stringify(holder.treeToSave(sm.liveTree()))) as Json;

    const loaded = new StateManager();
    loaded.loadTree(stored);
    const later = new RollbackSnapshot(P);
    later.restoreLoaded(loaded);
    const marker = loaded.get(P.rollbackPatch);
    expect(marker).toMatch(ROLLBACK_MARKER_PREFIX);
    expect(JSON.stringify(later.get(marker))).toBe(JSON.stringify(atRoundStart));
    // The held snapshot is not the live tree's: changing one leaves the other.
    loaded.set('角色.基础信息.当前位置', '扬州', 'command');
    expect((later.get(marker)?.角色 as { 基础信息: Json }).基础信息.当前位置).toBe('长安');
  });

  it('takes out on load a record made for another tree, or a marker a save should never hold', () => {
    for (const value of [
      { format: 1, ops: [], base: { round: 99, historyLength: 2 } },
      'round-start:1',
      { format: 1, ops: 'not a patch', base: { round: 3, historyLength: 2 } },
    ]) {
      const loaded = new StateManager();
      loaded.loadTree({ ...game(), 系统: { 扩展: { rollbackPatch: value } } });
      const holder = new RollbackSnapshot(P);
      holder.capture(game(1));
      holder.restoreLoaded(loaded);
      expect(loaded.get(P.rollbackPatch)).toBeUndefined();
      expect(holder.current()).toBeUndefined();
    }
    const plain = new StateManager();
    plain.loadTree(game());
    const holder = new RollbackSnapshot(P);
    holder.restoreLoaded(plain);
    expect(plain.get(P.rollbackPatch)).toBeUndefined();
    expect(plain.liveTree()).toEqual(game());
  });
});

function readMarker(tree: GameStateTree): unknown {
  return ((tree.系统 as { 扩展?: Json } | undefined)?.扩展 ?? {}).rollbackPatch;
}
