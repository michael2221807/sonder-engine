/**
 * NpcMainRoundUpdateModule — the round the main round last updated each NPC (P8, PO 2026-10-04), which the world
 * heartbeat's 遗忘回合数 measures (demo `上次主回合更新回合`).
 */
import { describe, it, expect } from 'vitest';
import { NpcMainRoundUpdateModule, touchedNpcNames } from './npc-main-round-update';
import { StateManager } from '../core/state-manager';
import { CommandExecutor, composePushGuards } from '../core/command-executor';
import { buildMemoryPushDedupGuard } from '../social/memory-dedup';
import { buildRelationshipMergeGuard } from '../social/relationship-merge-guard';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import type { StateChange } from '../types';

const REL = DEFAULT_ENGINE_PATHS.relationships;
const NAME = DEFAULT_ENGINE_PATHS.npcFieldNames.name;
const KEY = DEFAULT_ENGINE_PATHS.npcFieldNames.lastMainRoundUpdate;

function change(path: string, action: StateChange['action'], newValue: unknown, oldValue: unknown = undefined): StateChange {
  return { path, action, newValue, oldValue, timestamp: 0 };
}

function game(npcs: Array<Record<string, unknown>>, round: number): StateManager {
  const sm = new StateManager();
  sm.loadTree({ 元数据: { 回合序号: round }, 社交: { 关系: npcs } });
  return sm;
}

const module = () => new NpcMainRoundUpdateModule(REL, DEFAULT_ENGINE_PATHS.roundNumber, DEFAULT_ENGINE_PATHS.npcFieldNames);
const recordOf = (sm: StateManager, name: string) => sm.get<number>(`${REL}[${NAME}=${name}].${KEY}`);

describe('touchedNpcNames', () => {
  const list = [{ 名称: '林晚照' }, { 名称: '程彦' }, { 名称: '白诗雅' }];

  it('names an NPC by its [名称=X] path, its index path, a push onto the list, and a changed entry of a list write', () => {
    const names = touchedNpcNames([
      change(`${REL}[名称=林晚照].好感度`, 'add', 54),
      change(`${REL}[1].位置`, 'set', '宿舍'),
      change(`${REL}[2]`, 'set', { 名称: '白诗雅', 好感度: 3 }, { 名称: '白诗雅' }),
      change(REL, 'push', [...list, { 名称: '新来的' }], list),
      change('角色.基础信息.当前位置', 'set', '宿舍'),
    ], REL, NAME, list);
    expect([...names].sort()).toEqual(['新来的', '林晚照', '白诗雅', '程彦'].sort());
  });

  it('a whole-list write names only the entries that changed or are new', () => {
    const names = touchedNpcNames([
      change(REL, 'set', [{ 名称: '林晚照', 好感度: 60 }, { 名称: '程彦' }, { 名称: '路人甲' }],
        [{ 名称: '林晚照', 好感度: 50 }, { 名称: '程彦' }]),
    ], REL, NAME, list);
    expect([...names].sort()).toEqual(['林晚照', '路人甲'].sort());
  });

  it('a filter that matched nothing touches nobody; a rename through the name filter names the new name', () => {
    const names = touchedNpcNames([
      change(`${REL}[名称=林晚照 ].好感度`, 'add', undefined),
      change(`${REL}[名称=程彦].名称`, 'set', '程彦之'),
    ], REL, NAME, [{ 名称: '林晚照' }, { 名称: '程彦之' }]);
    expect([...names]).toEqual(['程彦之']);
  });

  it('a filter on another field names the record it matched, and one on the field it rewrote matches the new value', () => {
    const now = [{ 名称: '林晚照', 类型: '普通' }, { 名称: '程彦', 类型: '重点' }];
    expect([...touchedNpcNames([change(`${REL}[类型=重点].位置`, 'set', '宿舍')], REL, NAME, now)]).toEqual(['程彦']);
    expect([...touchedNpcNames([change(`${REL}[类型=重点].类型`, 'set', '普通', '重点')], REL, NAME,
      [{ 名称: '林晚照', 类型: '普通' }, { 名称: '程彦', 类型: '普通' }])]).toEqual(['林晚照']);
  });

  it('a list that filled to capacity may have dropped its oldest entry, so earlier index paths name nobody', () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ 名称: `N${i}` }));
    const names = touchedNpcNames([
      change(`${REL}[150].好感度`, 'set', 5, 4),
      change(`${REL}[名称=N7].位置`, 'set', '宿舍'),
      change(REL, 'push', [...full.slice(1), { 名称: '新来的' }], full.slice(1)),
    ], REL, NAME, [...full.slice(1), { 名称: '新来的' }]);
    expect([...names].sort()).toEqual(['N7', '新来的'].sort());
  });
});

describe('NpcMainRoundUpdateModule', () => {
  it('after the main round\'s commands, each NPC they touched gets the round; the others keep theirs', () => {
    const sm = game([{ 名称: '林晚照', [KEY]: 3 }, { 名称: '程彦', [KEY]: 3 }], 12);
    const executor = new CommandExecutor(sm, ['社交', '元数据']);
    const { changeLog } = executor.executeBatch([
      { action: 'add', key: `${REL}[名称=林晚照].好感度`, value: 4 },
      { action: 'push', key: REL, value: { 名称: '新来的', 好感度: 0 } },
    ]);
    module().afterCommands(sm, changeLog);
    expect(recordOf(sm, '林晚照')).toBe(12);
    expect(recordOf(sm, '新来的')).toBe(12);
    expect(recordOf(sm, '程彦')).toBe(3);
  });

  it('an index path is read against the list as it was then, not after a later pull in the same batch moved it', () => {
    const sm = game([{ 名称: 'A' }, { 名称: 'B' }, { 名称: 'C' }, { 名称: 'D' }], 20);
    const executor = new CommandExecutor(sm, null);
    // add records the resolved index path (关系[2]), and the pull then moves D to index 2.
    const { changeLog } = executor.executeBatch([
      { action: 'add', key: `${REL}[名称=C].好感度`, value: 3 },
      { action: 'pull', key: REL, value: { 名称: 'A' } },
    ]);
    expect(changeLog.changes[0].path).toBe(`${REL}[2].好感度`);
    module().afterCommands(sm, changeLog);
    expect(recordOf(sm, 'C')).toBe(20);
    expect(recordOf(sm, 'D')).toBeUndefined();
  });

  it('a push merged into an existing NPC by the production guard stamps that NPC', () => {
    const sm = game([{ 名称: '林晚照', 好感度: 50, [KEY]: 2 }, { 名称: '程彦', [KEY]: 2 }], 30);
    const guard = composePushGuards(
      buildMemoryPushDedupGuard(DEFAULT_ENGINE_PATHS.npcFieldNames.memory),
      buildRelationshipMergeGuard(sm, REL, DEFAULT_ENGINE_PATHS.npcFieldNames),
    );
    const executor = new CommandExecutor(sm, null, guard);
    const { changeLog } = executor.executeBatch([{ action: 'push', key: REL, value: { 名称: '林晚照', 位置: '宿舍' } }]);
    expect(sm.get<unknown[]>(REL)).toHaveLength(2);
    module().afterCommands(sm, changeLog);
    expect(recordOf(sm, '林晚照')).toBe(30);
    expect(recordOf(sm, '程彦')).toBe(2);
  });

  it('loading a game starts the clock of every NPC without a record, and leaves the others alone', () => {
    const sm = game([{ 名称: '林晚照', [KEY]: 7 }, { 名称: '程彦' }, { 名称: '白诗雅' }], 140);
    module().onGameLoad(sm);
    expect(recordOf(sm, '林晚照')).toBe(7);
    expect(recordOf(sm, '程彦')).toBe(140);
    expect(recordOf(sm, '白诗雅')).toBe(140);
    // Nothing to do on a second load.
    const before = JSON.stringify(sm.get(REL));
    module().onGameLoad(sm);
    expect(JSON.stringify(sm.get(REL))).toBe(before);
  });
});
