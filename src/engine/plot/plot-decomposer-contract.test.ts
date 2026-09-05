/**
 * Narrative Contract in the plot decomposition context (R2 second batch, plan S4).
 *
 * `buildContext()` feeds decompose / decomposeThreads / revise / reviseNode through
 * `{{PLOT_CONTEXT}}`. With clauses the player's melody leads the context; without them
 * the context is byte-identical to the pre-feature output.
 */
import { describe, it, expect } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { PlotDecomposer } from './plot-decomposer';
import type { AIService } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { GamePack } from '../types';

const P = DEFAULT_ENGINE_PATHS;
const F = P.npcFieldNames;

function makeSm(contract?: unknown): StateManager {
  const sm = new StateManager();
  sm.loadTree({
    元数据: { 回合序号: 12, 剧情导向: { activeArcIndex: 0, focusArcId: 'a', arcs: [] } },
    世界: { 描述: '南方小城', 时间: { 年: 1, 月: 3, 日: 9 } },
    角色: { 基础信息: { 姓名: '林默', 当前位置: '教学楼' } },
    社交: { 关系: [{ [F.name]: '周扬', [F.type]: '重点', [F.description]: '同桌' }, { [F.name]: '路人', [F.type]: P.npcTypeExclude }], 事件: { 事件记录: [] } },
    记忆: { 中期: [], 长期: [] },
    系统: { 扩展: { slotWorldBooks: [], ...(contract === undefined ? {} : { narrativeContract: contract }) } },
  });
  return sm;
}

function makeDecomposer(sm: StateManager): PlotDecomposer {
  const pack = {
    prompts: {},
    engineFragments: {
      narrativeContractTitle: '【叙事契约】',
      narrativeContractAuthority: '玩家声明：',
      narrativeContractCastLabel: '【主线人物】',
      narrativeContractPeripheralRule: '名单外只作背景。',
      narrativeContractCastSeparator: '、',
    },
  } as unknown as GamePack;
  return new PlotDecomposer({} as AIService, {} as ResponseParser, sm, pack, P);
}

describe('PlotDecomposer.buildContext · narrative contract', () => {
  it('leads the context with the contract block when the save has clauses', () => {
    const ctx = makeDecomposer(makeSm({ enabled: true, clauses: [{ id: 'c', text: '周扬底色是护不是猎。', enabled: true, source: 'player', createdRound: 3 }] })).buildContext();
    expect(ctx.startsWith('【叙事契约】\n玩家声明：\n1. 周扬底色是护不是猎。\n【主线人物】周扬\n名单外只作背景。')).toBe(true);
    expect(ctx.indexOf('【叙事契约】')).toBeLessThan(ctx.indexOf('剧情账本'));
  });

  it('is byte-identical to the pre-feature context when there are no clauses or no key at all', () => {
    const without = makeDecomposer(makeSm()).buildContext();
    const empty = makeDecomposer(makeSm({ enabled: true, clauses: [] })).buildContext();
    const off = makeDecomposer(makeSm({ enabled: false, clauses: [{ id: 'c', text: 'x', enabled: true, source: 'player', createdRound: 1 }] })).buildContext();
    expect(empty).toBe(without);
    expect(off).toBe(without);
    expect(without).not.toContain('叙事契约');
    expect(without.startsWith('## ① 剧情账本')).toBe(true);
  });
});
