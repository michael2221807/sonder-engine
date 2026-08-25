/**
 * Plot Revise & Extend — PlotReviser (docs/design/plot-arc-revise-extend.md §3.2/§3.3).
 * Zero real API: AIService is a stub.
 */
import { describe, it, expect, vi } from 'vitest';
import { StateManager } from '../core/state-manager';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { PlotDecomposer } from './plot-decomposer';
import { PlotReviser } from './plot-reviser';
import type { AIService } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { GamePack } from '../types';
import type { PlotNode } from './types';

function node(id: string, arcId: string, over: Partial<PlotNode> = {}): PlotNode {
  return {
    id, arcId, title: id, narrativeGoal: `goal-${id}`, directive: `dir-${id}`, completionHint: `hint-${id}`,
    completionConditions: [], completionMode: 'hint_only', activationConditions: [],
    importance: 'skippable', opportunityTiers: [], status: 'pending', consecutiveReachedCount: 0,
    ...over,
  };
}

function makeSm(): StateManager {
  const sm = new StateManager();
  sm.loadTree({
    元数据: {
      回合序号: 12,
      剧情导向: {
        activeArcIndex: 0, focusArcId: 'a',
        arcs: [
          {
            id: 'a', title: '高考冲刺篇', synopsis: '一个月冲刺', status: 'active',
            gauges: [{ id: 'g1', name: '怀疑', description: '同学的怀疑', min: 0, max: 100, current: 45, initialValue: 0, unit: '%', showInMainPanel: true, aiUpdatable: true, maxDeltaPerRound: 25 }],
            nodes: [
              node('a0', 'a', { title: '发现秘密', status: 'completed', completionEvidence: '目睹服药', activatedAtRound: 3, completedAtRound: 5 }),
              node('a1', 'a', { title: '模拟考异常', status: 'active', activatedAtRound: 6, premise: '承接秘密', stakes: '怀疑扩散', emotionalTone: 'tension' }),
              node('a2', 'a', { title: '道德抉择' }),
            ],
          },
          { id: 'c', title: '已完成线', synopsis: '', status: 'completed', gauges: [], nodes: [node('c1', 'c', { status: 'completed' })] },
        ],
      },
    },
    世界: { 时间: { 年: 1, 月: 3, 日: 9 } },
  });
  return sm;
}

function makeReviser(reply: unknown, fragments: Record<string, string> = {}) {
  const sm = makeSm();
  type GenReq = { messages: Array<{ role: string; content: string }>; usageType: string };
  const generate = vi.fn<(req: GenReq) => Promise<string>>(async () => JSON.stringify(reply));
  const ai = { generate } as unknown as AIService;
  const parser = { parse: (raw: string) => ({ text: raw, customFields: undefined }) } as unknown as ResponseParser;
  const pack = {
    prompts: {
      plotRevise: 'REVISE\n{{PLOT_REVISE_REQUEST}}\n{{PLOT_REVISE_ARC}}\n{{PLOT_REVISE_GAUGES}}\n{{PLOT_CONTEXT}}',
      plotReviseNode: 'REVISE_NODE\n{{PLOT_NODE_REQUEST}}\n{{PLOT_NODE_CHAIN}}\n{{PLOT_CONTEXT}}',
    },
    engineFragments: fragments,
  } as unknown as GamePack;
  const d = new PlotDecomposer(ai, parser, sm, pack, DEFAULT_ENGINE_PATHS);
  return { r: new PlotReviser(d, sm, pack, DEFAULT_ENGINE_PATHS), generate };
}

const okReply = { nodes: [{ title: '道德抉择', premise: 'p', narrativeGoal: 'g', directive: 'd', completionHint: 'h' }] };

describe('PlotReviser.revise', () => {
  it('renders the arc with immutable/active/pending markers, full content fields, gauges with current values, and the plot context', async () => {
    const { r, generate } = makeReviser(okReply);
    const res = await r.revise('a', '把后面改成她主动退赛');
    expect(res).not.toBeNull();
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.startsWith('REVISE'))!.content;
    expect(sys).toContain('把后面改成她主动退赛');
    expect(sys).toContain('【已发生·不可修改】《发现秘密》');
    expect(sys).toContain('  完成证据：目睹服药');
    expect(sys).toContain('【正在进行】《模拟考异常》');
    expect(sys).toContain('  承接：承接秘密');
    expect(sys).toContain('  引导：dir-a1');
    expect(sys).toContain('  改变：怀疑扩散');
    expect(sys).toContain('  基调：tension');
    expect(sys).toContain('importance: skippable · maxRounds: 6');
    expect(sys).toContain('【可改写】《道德抉择》');
    // completed nodes hide guidance fields (they are history, not instructions)
    expect(sys).not.toContain('dir-a0');
    expect(sys).toContain('- 怀疑（0-100%）当前 45 — 同学的怀疑');
    expect(sys).toContain('剧情账本'); // decomposer.buildContext rode along
    expect(generate.mock.calls[0][0].usageType).toBe('plot_decompose');
  });

  it('parses synopsis, whitelisted active_node_update (snake_case too), nodes, and explicit-current gauges', async () => {
    const { r } = makeReviser({
      synopsis: '新概要',
      active_node_update: { directive: '新引导', completion_hint: '新标志', status: 'completed', id: 'evil', maxRounds: 99 },
      nodes: [{ title: '主动退赛', premise: 'p', narrativeGoal: 'g', directive: 'd', completionHint: 'h' }],
      gauges: [{ name: '怀疑', current: 80 }, { name: '决心', min: 0, max: 10, unit: '点' }],
    });
    const res = (await r.revise('a', 'req'))!;
    expect(res.synopsis).toBe('新概要');
    expect(res.activeNodeUpdate).toEqual({ directive: '新引导', completionHint: '新标志' });
    expect(res.nodes).toHaveLength(1);
    expect(res.gauges).toEqual([
      expect.objectContaining({ name: '怀疑', current: 80 }),
      expect.objectContaining({ name: '决心', min: 0, max: 10, unit: '点', current: undefined }),
    ]);
  });

  it('refuses completed/missing threads and a reply without nodes; empty nodes array is a valid "cut the future"', async () => {
    const { r } = makeReviser(okReply);
    expect(await r.revise('c', 'req')).toBeNull();
    expect(await r.revise('missing', 'req')).toBeNull();
    const { r: r2 } = makeReviser({ synopsis: 'x' });
    expect(await r2.revise('a', 'req')).toBeNull();
    const { r: r3 } = makeReviser({ nodes: [] });
    const res = (await r3.revise('a', 'req'))!;
    expect(res.nodes).toEqual([]);
    expect(res.gauges).toEqual([]);
  });

  it('ignores the decompose flows\' additive `suggested_gauges` key — it must never read as a full-replacement list', async () => {
    const { r } = makeReviser({ nodes: okReply.nodes, suggested_gauges: [{ name: '新度量' }] });
    const res = (await r.revise('a', 'req'))!;
    expect(res.gauges).toEqual([]);
  });

  it('allowActiveNodeUpdate=false: the in-progress node renders as immutable AND a returned active_node_update is discarded', async () => {
    const reply = { ...okReply, active_node_update: { directive: '不应生效' } };
    const { r, generate } = makeReviser(reply);
    const res = (await r.revise('a', 'req', { allowActiveNodeUpdate: false }))!;
    expect(res.activeNodeUpdate).toBeUndefined();
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.startsWith('REVISE'))!.content;
    expect(sys).toContain('【已发生·不可修改】《模拟考异常》');
    expect(sys).not.toContain('【正在进行】');
    // default (true) keeps both behaviours
    const { r: r2 } = makeReviser(reply);
    const res2 = (await r2.revise('a', 'req'))!;
    expect(res2.activeNodeUpdate).toEqual({ directive: '不应生效' });
  });

  it('reviseNode: full chain rendered with target/planned/immutable markers + evidence, one node parsed back, plot context included', async () => {
    const reply = { node: { title: '道德抉择', premise: '承接退赛风波', narrativeGoal: '新事件', directive: 'd', completionHint: 'h' } };
    const { r, generate } = makeReviser(reply);
    // Chain mirrors the preview: 2 history nodes + 2 proposal nodes, rewrite the 2nd proposal (index 3).
    const chain = [
      { title: '发现秘密', kind: 'done' as const, narrativeGoal: 'g0', evidence: '目睹服药', directive: '不应出现0' },
      { title: '模拟考异常', kind: 'active' as const, narrativeGoal: 'g1', directive: 'dir1' },
      { title: '主动退赛', kind: 'planned' as const, narrativeGoal: 'g2', directive: 'dir2' },
      { title: '道德抉择', kind: 'planned' as const, narrativeGoal: 'g3', directive: 'dir3' },
    ];
    const res = await r.reviseNode({ title: '高考冲刺篇', synopsis: '一个月冲刺', status: 'active' }, chain, 3, '不要动手，改成误会');
    expect(res).toEqual(expect.objectContaining({ title: '道德抉择', premise: '承接退赛风波', narrativeGoal: '新事件' }));
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.includes('不要动手'))!.content;
    expect(sys).toContain('【已发生·不可修改】《发现秘密》');
    expect(sys).toContain('  完成证据：目睹服药');
    expect(sys).not.toContain('不应出现0');                      // done nodes hide guidance
    expect(sys).toContain('【正在进行】《模拟考异常》');          // fixed context, but NOT "happened"
    expect(sys).toContain('  引导：dir1');
    expect(sys).toContain('【计划中·不可改动】《主动退赛》');
    expect(sys).toContain('【要改的节点】《道德抉择》');
    expect(sys).toContain('剧情账本');
    expect(generate.mock.calls[0][0].usageType).toBe('plot_decompose');
  });

  it('reviseNode rejects a done or out-of-range target and an unusable reply; active and planned targets are both rewritable', async () => {
    const chainDone = [{ title: 'a', kind: 'done' as const }, { title: 'b', kind: 'planned' as const }];
    const arcRef = { title: 'T', synopsis: '', status: 'active' as const };
    const { r } = makeReviser({ node: { title: 'x' } });
    expect(await r.reviseNode(arcRef, chainDone, 0, 'req')).toBeNull();  // done target
    expect(await r.reviseNode(arcRef, chainDone, 9, 'req')).toBeNull();  // out of range
    const { r: r2 } = makeReviser({ something: 'else' });
    expect(await r2.reviseNode(arcRef, chainDone, 1, 'req')).toBeNull(); // no node in reply
    // nodes-array fallback shape is accepted
    const { r: r3 } = makeReviser({ nodes: [{ title: 'b', narrativeGoal: 'ng' }] });
    expect(await r3.reviseNode(arcRef, chainDone, 1, 'req')).toEqual(expect.objectContaining({ title: 'b', narrativeGoal: 'ng' }));
    // an in-progress node is a legal target (real-thread entry, D1) and renders the target marker
    const chainActive = [{ title: 'a', kind: 'done' as const }, { title: 'b', kind: 'active' as const, narrativeGoal: 'gb' }, { title: 'c', kind: 'planned' as const }];
    const { r: r4, generate } = makeReviser({ node: { title: 'b', narrativeGoal: 'ng2' } });
    expect(await r4.reviseNode(arcRef, chainActive, 1, 'req')).toEqual(expect.objectContaining({ narrativeGoal: 'ng2' }));
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.startsWith('REVISE_NODE'))!.content;
    expect(sys).toContain('【要改的节点】《b》');
    expect(sys).toContain('【计划中·不可改动】《c》');
  });

  it('EN fragments: the rendered arc/gauge scaffolding contains no Chinese', async () => {
    const en = {
      plotRevArcHeader: '## Target thread "{title}" [{status}]',
      plotRevSynopsisLine: 'Synopsis: {text}',
      plotRevMarkImmutable: '[happened · immutable]', plotRevMarkActive: '[in progress]', plotRevMarkPending: '[rewritable]',
      plotRevNodeLine: '{marker} "{title}"',
      plotRevFieldPremise: '  Builds on: {text}', plotRevFieldGoal: '  Event: {text}', plotRevFieldDirective: '  Guidance: {text}',
      plotRevFieldStakes: '  Changes: {text}', plotRevFieldHint: '  Completion sign: {text}', plotRevFieldTone: '  Tone: {text}',
      plotRevFieldEvidence: '  Completion evidence: {text}', plotRevFieldMeta: '  importance: {importance} · maxRounds: {maxRounds}',
      plotRevGaugesHeader: '## Gauges', plotRevGaugeLine: '- {name} ({min}-{max}{unit}) now {current}{desc}',
      plotRevGaugeDescSep: ' — ', plotRevGaugesEmpty: '(none)',
    };
    const { r, generate } = makeReviser(okReply, en);
    await r.revise('a', 'request');
    const sys = generate.mock.calls[0][0].messages.find(m => m.content.startsWith('REVISE'))!.content;
    const arcBlock = sys.split('剧情账本')[0]; // buildContext labels are the decomposer's concern
    // node/gauge content itself is authored Chinese from the save — strip known content words
    const scaffolding = arcBlock
      .replace(/把后面改成她主动退赛|高考冲刺篇|一个月冲刺|发现秘密|模拟考异常|道德抉择|目睹服药|承接秘密|怀疑扩散|同学的怀疑|怀疑/g, '');
    expect(/[一-鿿]/.test(scaffolding)).toBe(false);
  });
});
