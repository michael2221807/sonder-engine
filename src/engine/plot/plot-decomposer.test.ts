/**
 * Plot Threads P5 — narrative-first decomposition context + multi-thread parsing
 * (docs/design/plot-parallel-threads-scheduler.md §7.2 / §7.4). Zero real API: AIService is a stub.
 */
import { describe, it, expect, vi } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { PlotDecomposer } from './plot-decomposer';
import type { AIService } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { GamePack } from '../types';

function makeSm(): StateManager {
  const sm = new StateManager();
  sm.loadTree({
    元数据: {
      回合序号: 12,
      剧情导向: {
        activeArcIndex: 0, focusArcId: 'a',
        arcs: [{ id: 'a', title: '高考冲刺篇', synopsis: '', status: 'active', gauges: [], nodes: [
          { id: 'a0', arcId: 'a', title: '发现禁药秘密', narrativeGoal: '', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'critical', opportunityTiers: [], status: 'completed', consecutiveReachedCount: 0, activatedAtRound: 6, completedAtRound: 11, completionEvidence: '主角目睹好友在更衣室服药' },
          { id: 'a1', arcId: 'a', title: '模拟考异常', narrativeGoal: '好友成绩离奇飙升', directive: '', completionHint: '', completionConditions: [], completionMode: 'hint_only', activationConditions: [], importance: 'critical', opportunityTiers: [], status: 'active', consecutiveReachedCount: 0, activatedAtRound: 12 },
        ] }],
      },
    },
    世界: { 描述: '2020 年代的南方高中', 时间: { 年: 1, 月: 3, 日: 9 } },
    角色: { 基础信息: { 姓名: '林默', 当前位置: '教学楼', 属性: { 体质: 9, 悟性: 7 } }, 属性: { 体质: 9, 悟性: 7, 气运: 3 } },
    社交: { 关系: [{ 名称: '周扬', 类型: '好友', 描述: '成绩突飞猛进的同桌', 好感度: 70 }], 事件: { 事件记录: [
      { 事件名称: '月考放榜', 事件描述: '周扬跃居年级第三', 回合: 9 },
    ] } },
    记忆: { 中期: [{ 记忆主体: '主角在储物柜发现药瓶' }], 长期: [{ 记忆主体: '主角与周扬自初中起是同桌' }] },
    系统: { 扩展: { slotWorldBooks: [{ id: 'canon', title: '自动设定集', enabled: true, entries: [
      { id: 'e1', title: '聪明药', content: '校外流传的一种灰色提神药物，长期服用会手抖。', type: 'world_lore', scope: ['main'], injectionMode: 'always', enabled: true, priority: 5 },
      { id: 'e2', title: '禁用条目', content: '不该出现', type: 'world_lore', scope: ['main'], injectionMode: 'always', enabled: false },
    ] }] }, 设置: { plot: { maxActiveThreads: 2 } } },
  });
  return sm;
}

function makeDecomposer(reply: unknown, sm = makeSm()) {
  type GenReq = { messages: Array<{ role: string; content: string }>; usageType: string };
  const generate = vi.fn<(req: GenReq) => Promise<string>>(async () => JSON.stringify(reply));
  const ai = { generate } as unknown as AIService;
  const parser = { parse: (raw: string) => ({ text: raw, customFields: undefined }) } as unknown as ResponseParser;
  const pack = {
    prompts: {
      plotDecompose: 'SINGLE\n{{PLOT_OUTLINE}}\n{{PLOT_CONTEXT}}\n{{PLOT_STATE_SUMMARY}}',
      plotDecomposeThreads: 'MULTI max={{PLOT_MAX_ACTIVE}}\n{{PLOT_OUTLINE}}\n{{PLOT_CONTEXT}}',
    },
    engineFragments: {},
  } as unknown as GamePack;
  return { d: new PlotDecomposer(ai, parser, sm, pack, DEFAULT_ENGINE_PATHS), generate };
}

describe('PlotDecomposer.buildContext (§7.2 four sections, plot-first)', () => {
  it('leads with the ledger (nodes + evidence), then world facts (events + enabled Canon), memory, name-level state — and never the raw state JSON', () => {
    const { d } = makeDecomposer({});
    const ctx = d.buildContext();
    const idx = (s: string) => ctx.indexOf(s);
    expect(idx('剧情账本')).toBeGreaterThanOrEqual(0);
    expect(idx('《高考冲刺篇》[active]')).toBeGreaterThan(idx('剧情账本'));
    expect(ctx).toContain('✓ 发现禁药秘密 (R6–R11) — 主角目睹好友在更衣室服药');
    expect(ctx).toContain('● 模拟考异常 (R12…) — 好友成绩离奇飙升');
    expect(idx('世界事实')).toBeGreaterThan(idx('剧情账本'));
    expect(ctx).toContain('- R9 月考放榜：周扬跃居年级第三');
    expect(ctx).toContain('- 聪明药：校外流传的一种灰色提神药物');
    expect(ctx).not.toContain('不该出现');
    expect(idx('记忆摘要')).toBeGreaterThan(idx('世界事实'));
    expect(ctx).toContain('主角与周扬自初中起是同桌');
    expect(idx('状态附录')).toBeGreaterThan(idx('记忆摘要'));
    expect(ctx).toContain('世界：2020 年代的南方高中');
    expect(ctx).toContain('主角：林默 · 位置：教学楼 · 回合：12 · 时间：1/3/9');
    expect(ctx).toContain('- 周扬·好友：成绩突飞猛进的同桌');
    // the old full-state dump is gone: no attribute numbers, no JSON braces
    expect(ctx).not.toContain('"体质"');
    expect(ctx).not.toContain('悟性');
    expect(ctx).not.toMatch(/\{\s*"/);
  });

  it('renders the prompt with PLOT_CONTEXT / PLOT_STATE_SUMMARY and still supports the legacy AbortSignal argument', async () => {
    const { d, generate } = makeDecomposer({ nodes: [{ title: 'n', premise: 'p', stakes: 's' }], suggested_gauges: [] });
    const ctrl = new AbortController();
    const res = await d.decompose('大纲', ctrl.signal);
    expect(res?.nodes[0]).toMatchObject({ title: 'n', premise: 'p', stakes: 's', importance: 'critical', maxRounds: 6 });
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.startsWith('SINGLE'))!;
    expect(sys.content).toContain('剧情账本');
    expect(sys.content).toContain('玩家：林默，当前位置：教学楼，回合：12');
    expect(sys.content).not.toContain('{{');
  });

  it('honours engineFragments for the context scaffolding (EN pack → no Chinese headers)', () => {
    const sm = makeSm();
    const pack = { prompts: {}, engineFragments: { plotCtxLedgerHeader: '## Ledger', plotCtxWorldFactsHeader: '## Facts', plotCtxMemoryHeader: '## Memory', plotCtxStateHeader: '## State', plotCtxEventsLabel: '### Events', plotCtxCanonLabel: '### Canon', plotCtxLongTermLabel: '### Long', plotCtxMidTermLabel: '### Mid', plotCtxWorldLine: 'World: {text}', plotCtxWhereLine: 'P {player} L {location} R {round}{time}', plotCtxTimeSep: ' T ', plotCtxNpcLabel: 'NPCs:', plotCtxThreadLine: '"{title}" [{status}]' } } as unknown as GamePack;
    const d = new PlotDecomposer({} as AIService, {} as ResponseParser, sm, pack, DEFAULT_ENGINE_PATHS);
    const ctx = d.buildContext();
    expect(ctx).toContain('## Ledger');
    expect(ctx).toContain('"高考冲刺篇" [active]');
    expect(ctx).toContain('## Facts');
    expect(ctx).not.toContain('剧情账本');
    expect(ctx).not.toContain('状态附录');
  });
});

describe('PlotDecomposer.decomposeThreads (§7.4 one call)', () => {
  const reply = {
    threads: [
      { title: '备考主线', synopsis: 's1', color: '#abc', activation: null,
        nodes: [{ title: '模拟考', premise: 'p', narrativeGoal: 'g', directive: 'd', stakes: 'st', completionHint: 'c', importance: 'critical', maxRounds: 5 }, { title: '高考日' }],
        gauges: [{ name: '压力', min: 0, max: 100, initialValue: 30, unit: '%' }] },
      { title: '匿名信风波', synopsis: 's2', activation: { after_node: '备考主线/模拟考' },
        nodes: [{ title: '信件出现' }], gauges: [] },
      { title: '毕业旅行', synopsis: 's3', activation: [{ after_thread: '备考主线' }, { at_round: 30 }],
        nodes: [{ title: '提议' }] },
      { title: '空线', synopsis: '', activation: null, nodes: [] },
      { title: '坏引用', synopsis: '', activation: { at_round: 'abc' }, nodes: [{ title: 'x' }] },
      { title: '字符串回合', synopsis: '', activation: { at_round: '30' }, nodes: [{ title: 'y' }] },
    ],
  };

  it('parses threads, drops node-less ones, normalises activation refs and renders the cap into the prompt', async () => {
    const { d, generate } = makeDecomposer(reply);
    const res = await d.decomposeThreads('大纲');
    expect(res?.threads.map(t => t.title)).toEqual(['备考主线', '匿名信风波', '毕业旅行', '坏引用', '字符串回合']);
    expect(res?.threads[3].activation).toBeNull();
    expect(res?.threads[3].malformedRefs).toHaveLength(1); // surfaced, not silently "starts now"
    expect(res?.threads[4].activation).toEqual([{ at_round: 30 }]); // numeric string coerced
    expect(res?.threads[0].malformedRefs).toEqual([]);
    expect(res?.threads[0].activation).toBeNull();
    expect(res?.threads[0].color).toBe('#abc');
    expect(res?.threads[0].nodes[0]).toMatchObject({ premise: 'p', stakes: 'st', maxRounds: 5 });
    expect(res?.threads[0].suggestedGauges[0]).toMatchObject({ name: '压力', current: 30, initialValue: 30 });
    expect(res?.threads[1].activation).toEqual([{ after_node: '备考主线/模拟考' }]);
    expect(res?.threads[2].activation).toEqual([{ after_thread: '备考主线' }, { at_round: 30 }]);
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.startsWith('MULTI'))!;
    expect(sys.content).toContain('max=2'); // from 系统.设置.plot.maxActiveThreads
    expect(generate.mock.calls[0][0].usageType).toBe('plot_decompose');
  });

  it('returns null when the reply has no threads array', async () => {
    const { d } = makeDecomposer({ nodes: [] });
    expect(await d.decomposeThreads('x')).toBeNull();
  });

  it('resolveThreadActivation maps title refs to id triggers and reports unresolved refs', () => {
    const created = [
      { id: 'arc1', title: '备考主线', nodes: [{ id: 'n1', title: '模拟考' }, { id: 'n2', title: '高考日' }] },
      { id: 'arc2', title: '匿名信风波', nodes: [{ id: 'm1', title: '信件出现' }] },
    ] as Array<{ id: string; title: string; nodes: Array<{ id: string; title: string }> }>;
    const cast = created as unknown as Parameters<typeof PlotDecomposer.resolveThreadActivation>[1];
    expect(PlotDecomposer.resolveThreadActivation(null, cast)).toEqual({ activation: null, unresolved: [] });
    expect(PlotDecomposer.resolveThreadActivation([{ after_node: '备考主线/模拟考' }], cast)).toEqual({
      activation: { mode: 'auto', triggers: [{ type: 'node_completed', arcId: 'arc1', nodeId: 'n1' }] }, unresolved: [],
    });
    expect(PlotDecomposer.resolveThreadActivation([{ after_thread: '备考主线' }, { at_round: 30 }], cast)).toEqual({
      activation: { mode: 'auto', triggers: [{ type: 'thread_completed', arcId: 'arc1' }, { type: 'round_reached', round: 30 }] }, unresolved: [],
    });
    const bad = PlotDecomposer.resolveThreadActivation([{ after_node: '不存在/节点' }, { after_thread: '备考主线' }], cast);
    expect(bad.unresolved).toEqual(['不存在/节点']);
    expect(bad.activation?.triggers).toHaveLength(1);
    expect(PlotDecomposer.resolveThreadActivation([{ after_node: '备考主线/没有这个节点' }], cast)).toEqual({ activation: null, unresolved: ['备考主线/没有这个节点'] });
  });
});
