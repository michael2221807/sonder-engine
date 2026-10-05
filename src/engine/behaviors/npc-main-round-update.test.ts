/**
 * NpcMainRoundUpdateModule — the round the main round last updated each NPC (P8, PO 2026-10-04), which the world
 * heartbeat's 遗忘回合数 measures (demo `上次主回合更新回合`).
 */
import { describe, it, expect } from 'vitest';
import { NpcMainRoundUpdateModule, touchedNpcNames } from './npc-main-round-update';
import { StateManager } from '../core/state-manager';
import { CommandExecutor } from '../core/command-executor';
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
      change(`${REL}[2]`, 'set', { 名称: '白诗雅', 好感度: 3 }),
      change(REL, 'push', [...list, { 名称: '新来的' }]),
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
