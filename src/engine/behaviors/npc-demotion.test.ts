/**
 * NpcDemotionModule — the settings page's 「NPC 降级阈值」 (PO 2026-10-05 5A; demo runNpcMaintenance,
 * worldHeartbeatService.ts:281-321): at round end a key NPC the main round has not updated for more than N rounds
 * becomes an ordinary one.
 */
import { describe, it, expect } from 'vitest';
import { NpcDemotionModule, demotionThresholdOf } from './npc-demotion';
import { StateManager } from '../core/state-manager';
import { BehaviorRunner } from './behavior-runner';
import { DEFAULT_ENGINE_PATHS, DEFAULT_NPC_DEMOTION_THRESHOLD } from '../pipeline/types';

const P = DEFAULT_ENGINE_PATHS;
const F = P.npcFieldNames;
const ORDINARY = P.npcTypeExclude;

function game(npcs: Array<Record<string, unknown>>, round: number, threshold?: unknown): StateManager {
  const sm = new StateManager();
  sm.loadTree({ 元数据: { 回合序号: round }, 社交: { 关系: npcs }, 系统: threshold === undefined ? {} : { npcDemotionThreshold: threshold } });
  return sm;
}
const module = () => new NpcDemotionModule(P.relationships, P.roundNumber, P.npcDemotionThreshold, ORDINARY, F);
const typeOf = (sm: StateManager, name: string) => sm.get<string>(`${P.relationships}[${F.name}=${name}].${F.type}`);

describe('NpcDemotionModule', () => {
  it('demotes a key NPC left alone longer than the threshold, and only that one', () => {
    const sm = game([
      { [F.name]: '久未出场', [F.type]: '重点', [F.lastMainRoundUpdate]: 10 },
      { [F.name]: '刚好到线', [F.type]: '重点', [F.lastMainRoundUpdate]: 15 },
      { [F.name]: '刚出场', [F.type]: '重点', [F.lastMainRoundUpdate]: 19 },
    ], 20, 5);
    module().onRoundEnd(sm);
    expect(typeOf(sm, '久未出场')).toBe(ORDINARY);
    expect(typeOf(sm, '刚好到线')).toBe('重点'); // 20 - 15 = 5, not more than 5
    expect(typeOf(sm, '刚出场')).toBe('重点');
  });

  it('a missing type counts as key; a watched NPC, one without a record and an ordinary one are left as they are', () => {
    const sm = game([
      { [F.name]: '没写类型', [F.lastMainRoundUpdate]: 1 },
      { [F.name]: '被关注', [F.type]: '重点', [F.attention]: true, [F.lastMainRoundUpdate]: 1 },
      { [F.name]: '没有记录', [F.type]: '重点' },
      { [F.name]: '本来普通', [F.type]: ORDINARY, [F.lastMainRoundUpdate]: 1 },
    ], 50);
    module().onRoundEnd(sm);
    expect(typeOf(sm, '没写类型')).toBe(ORDINARY);
    expect(typeOf(sm, '被关注')).toBe('重点');
    expect(typeOf(sm, '没有记录')).toBe('重点');
    expect(typeOf(sm, '本来普通')).toBe(ORDINARY);
  });

  it('uses the default threshold when the save has none or an unusable one', () => {
    expect(demotionThresholdOf(undefined)).toBe(DEFAULT_NPC_DEMOTION_THRESHOLD);
    expect(demotionThresholdOf(0)).toBe(DEFAULT_NPC_DEMOTION_THRESHOLD);
    expect(demotionThresholdOf('7')).toBe(DEFAULT_NPC_DEMOTION_THRESHOLD);
    expect(demotionThresholdOf(12.8)).toBe(12);
    const sm = game([{ [F.name]: 'A', [F.type]: '重点', [F.lastMainRoundUpdate]: 14 }], 20);
    module().onRoundEnd(sm); // 6 > 5 (default)
    expect(typeOf(sm, 'A')).toBe(ORDINARY);
  });

  it('runs from the round-end hook the main round calls (post-process), not on load or after commands', () => {
    const runner = new BehaviorRunner();
    runner.register(module());
    const sm = game([{ [F.name]: 'A', [F.type]: '重点', [F.lastMainRoundUpdate]: 1 }], 30, 5);
    runner.runOnGameLoad(sm);
    runner.runAfterCommands(sm, { changes: [], source: 'command', timestamp: 0 });
    expect(typeOf(sm, 'A')).toBe('重点');
    runner.runOnRoundEnd(sm);
    expect(typeOf(sm, 'A')).toBe(ORDINARY);
  });
});
