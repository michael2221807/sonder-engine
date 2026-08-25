// App doc: docs/user-guide/pages/game-plot.md §数据流 (PLOT_* 注入变量 · 焦点线/背景线)
// Design: docs/design/plot-direction-system.md
// Design (threads): docs/design/plot-parallel-threads-scheduler.md §4.3 (Step 1/2 contract), §7.2, §8.4
/**
 * Plot Direction System — Prompt Variable Builder
 *
 * Constructs PLOT_DIRECTIVE / PLOT_BACKGROUND_THREADS (step1) and
 * PLOT_EVAL_CONTEXT + PLOT_COMPLETION_HINT + PLOT_GAUGE_INSTRUCTIONS (step2)
 * with sufficient context for the model to understand AND act on the data.
 *
 * Every human-readable label comes from `GamePack.engineFragments` (keys
 * `plot*`, see `DEFAULT_PLOT_LABELS` for the full list and the zh defaults);
 * the EN pack overrides them in `prompts-en/engine-fragments.json`. The engine
 * therefore never decides the prompt language (CLAUDE.md §4 / i18n constraint).
 *
 * Design principle: the model should be able to answer these questions from the injected text:
 *   1. What story thread is this? What happened so far (and how)?
 *   2. What should this scene accomplish, building on which fact, changing what?
 *   3. What gauges exist, what do they mean, and what are their current values?
 *   4. How should the model report gauge changes? (exact field names + format)
 *   5. For EVERY active thread: what does "node complete" look like?
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { PlotDirectionState, PlotArc, PlotNode, PlotGauge } from './types';
import { resolveFocusArc, getActiveArcs } from './types';

const MAX_COMPLETED_SUMMARY = 3;
/** Evidence strings are AI-authored; cap them so the ledger line cannot grow unbounded. */
const MAX_EVIDENCE_CHARS = 80;

// ═══════════════════════════════════════════════════════════════
//  Labels (pack-overridable)
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_PLOT_LABELS = {
  plotArcLabel: '弧线：{title}',
  plotSynopsisLabel: '概要：{text}',
  plotCompletedLabel: '已完成：{list}',
  plotCompletedMore: '...+{n}, ',
  plotCompletedItem: '{title}：{evidence}',
  plotCompletedSep: '；',
  plotCurrentNodeLabel: '【当前节点：{title}】',
  plotPremiseLabel: '承接：{text}',
  plotEventLabel: '事件：{text}',
  plotDirectiveLabel: '引导：{text}',
  plotStakesLabel: '改变：{text}',
  plotToneLabel: '基调：{text}',
  plotNextNodeLabel: '【下一节点（预告）】《{title}》{goal}',
  plotNextNodeHint: '可为其自然铺垫、埋下伏笔，但本回合不要让它发生。',
  plotGaugesHeader: '【剧情度量值】',
  plotGaugeLine: '- {name}: {current}/{max}{unit} ({range}){desc}',
  plotGaugeDescSep: ' — ',
  plotGaugesHint: '你的叙事应自然反映这些数值的含义和变化趋势。',
  plotOpportunityLabel: '【引导提示】{text}',
  plotBackgroundHeader: '【并行中的其他剧情线】',
  plotBackgroundLine: '- 《{title}》当前：{node}{goal}{gauges}',
  plotBackgroundGoalSep: ' — ',
  plotBackgroundGaugeSep: ' · 度量：',
  plotBackgroundHint: '以上剧情线与焦点线同时进行：保持它们的事实与走向不矛盾，可在合适处自然带到；若本轮叙事自然触及它们的当前节点可以推进，但不要为此偏离焦点。',
  plotEvalThreadHeader: '【剧情线 {index}：{title}】',
  plotEvalNodeLabel: '当前节点：{title}',
  plotEvalEventLabel: '节点事件：{text}',
  plotEvalHintLabel: '完成标志："{text}"',
  plotGaugeInstrHeader: '根据本轮叙事内容，在 gauge_updates 中报告度量值变化：',
  plotGaugeInstrHeaderMulti: '根据本轮叙事内容，在对应剧情线条目的 gauge_updates 中报告度量值变化：',
  plotGaugeInstrThread: '〔{title}〕',
  plotGaugeInstrLine: '- "{name}": 当前{current}/{max}{unit}{desc}',
  plotGaugeInstrFormat: '格式：gauge_updates: [{ "gauge_id": "度量值名称", "delta": 变化量, "reason": "原因" }]',
  plotGaugeInstrNote: '注意：gauge_id 填写度量值的名称（如上方引号中的文字），delta 为正数表示增加、负数表示减少。',
  plotGaugeInstrManaged: '以下度量值由系统管理，请勿修改：{names}',
  plotThreadTitleSep: '、',
  plotHintJoinSep: ' / ',
} satisfies Record<string, string>;

export type PlotPromptLabels = { [K in keyof typeof DEFAULT_PLOT_LABELS]: string };

/** Fragment-backed labels; any key absent from the pack falls back to the zh default. */
export function resolvePlotLabels(fragments?: Record<string, unknown>): PlotPromptLabels {
  const out: PlotPromptLabels = { ...DEFAULT_PLOT_LABELS };
  if (!fragments) return out;
  for (const key of Object.keys(DEFAULT_PLOT_LABELS) as Array<keyof PlotPromptLabels>) {
    const v = fragments[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : ''));
}

// ═══════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════

/** The FOCUS thread (D2) is the one injected in full. */
function getActiveArc(state: PlotDirectionState | undefined): PlotArc | null {
  return resolveFocusArc(state);
}

function getActiveNode(arc: PlotArc): PlotNode | null {
  return arc.nodes.find(n => n.status === 'active') ?? null;
}

/** Active threads in lane order, each with its active node. */
function getActiveThreads(state: PlotDirectionState | undefined): Array<{ arc: PlotArc; node: PlotNode }> {
  const active = getActiveArcs(state).sort((p, q) => (p.lane ?? Infinity) - (q.lane ?? Infinity));
  return active.flatMap(arc => {
    const node = getActiveNode(arc);
    return node ? [{ arc, node }] : [];
  });
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/**
 * Recent completed nodes as "title：evidence" (the ledger the next scene
 * builds on — §7.2). Older ones are folded into a count.
 */
function buildCompletedSummary(arc: PlotArc, L: PlotPromptLabels): string {
  const completed = arc.nodes.filter(n => n.status === 'completed');
  if (completed.length === 0) return '';
  const recent = completed.slice(-MAX_COMPLETED_SUMMARY);
  const prefix = completed.length > MAX_COMPLETED_SUMMARY
    ? fmt(L.plotCompletedMore, { n: completed.length - MAX_COMPLETED_SUMMARY })
    : '';
  return prefix + recent
    .map(n => (n.completionEvidence
      ? fmt(L.plotCompletedItem, { title: n.title, evidence: clip(n.completionEvidence, MAX_EVIDENCE_CHARS) })
      : n.title))
    .join(L.plotCompletedSep);
}

/**
 * First pending node after the current one — the "most likely next beat"
 * (plot-arc-revise-extend §5.1 lookahead). Nodes gated by unmet
 * activationConditions still qualify: the preview is a foreshadowing cue,
 * not a promise, and Step 2 never sees it.
 */
function getNextPendingNode(arc: PlotArc, current: PlotNode): PlotNode | null {
  const idx = arc.nodes.indexOf(current);
  return arc.nodes.slice(idx + 1).find(n => n.status === 'pending') ?? null;
}

function getCurrentOpportunity(node: PlotNode, currentRound: number): string {
  if (!node.activatedAtRound || node.opportunityTiers.length === 0) return '';
  const elapsed = currentRound - node.activatedAtRound;
  let best: string | null = null;
  for (const t of node.opportunityTiers) {
    if (elapsed >= t.afterRounds) best = t.prompt;
  }
  return best ?? '';
}

/** Full gauge context block — name, description, value, range. */
function buildGaugeContext(gauges: PlotGauge[], L: PlotPromptLabels): string {
  if (gauges.length === 0) return '';
  return gauges.map(g => fmt(L.plotGaugeLine, {
    name: g.name, current: g.current, max: g.max, unit: g.unit,
    range: `${g.min}-${g.max}`,
    desc: g.description ? L.plotGaugeDescSep + g.description : '',
  })).join('\n');
}

/** Compressed gauge line for background threads: `怀疑45% | 倒计时12天`. */
function buildGaugeCompact(gauges: PlotGauge[]): string {
  return gauges.map(g => `${g.name}${g.current}${g.unit}`).join(' | ');
}

/** Step 1 directive — everything the model needs to write the scene. */
function buildDirectiveBlock(arc: PlotArc, node: PlotNode, round: number, L: PlotPromptLabels): string {
  const sections: string[] = [];

  const isFirstRound = node.activatedAtRound === round;
  if (isFirstRound) {
    sections.push(fmt(L.plotArcLabel, { title: arc.title }));
    if (arc.synopsis) sections.push(fmt(L.plotSynopsisLabel, { text: arc.synopsis }));
    sections.push('');
  }

  const completed = buildCompletedSummary(arc, L);
  if (completed) sections.push(fmt(L.plotCompletedLabel, { list: completed }));

  // Current node — full context (§7.2: premise/stakes anchor the scene in facts)
  sections.push(fmt(L.plotCurrentNodeLabel, { title: node.title }));
  if (node.premise) sections.push(fmt(L.plotPremiseLabel, { text: node.premise }));
  if (node.narrativeGoal) sections.push(fmt(L.plotEventLabel, { text: node.narrativeGoal }));
  sections.push(fmt(L.plotDirectiveLabel, { text: node.directive }));
  if (node.stakes) sections.push(fmt(L.plotStakesLabel, { text: node.stakes }));
  if (node.emotionalTone) sections.push(fmt(L.plotToneLabel, { text: node.emotionalTone }));

  // Lookahead (§5.1, always on): one-line preview of the next beat so the
  // model can foreshadow instead of writing the current node into a dead end.
  const next = getNextPendingNode(arc, node);
  if (next) {
    const goal = next.narrativeGoal || next.premise || '';
    sections.push(
      '',
      // plotBackgroundGoalSep is deliberately shared with the background-thread
      // line: both are "title — one-line goal" summaries and should read alike.
      fmt(L.plotNextNodeLabel, { title: next.title, goal: goal ? L.plotBackgroundGoalSep + goal : '' }),
      L.plotNextNodeHint,
    );
  }

  const gaugeBlock = buildGaugeContext(arc.gauges, L);
  if (gaugeBlock) {
    sections.push('', L.plotGaugesHeader, gaugeBlock, L.plotGaugesHint);
  }

  const opp = getCurrentOpportunity(node, round);
  if (opp) sections.push('', fmt(L.plotOpportunityLabel, { text: opp }));

  return sections.join('\n');
}

/**
 * One line per non-focus active thread (D2). Returns '' when there are none so
 * the template placeholder renders empty (new-builder path has no `#if`);
 * otherwise starts with a blank line so it separates from the template text.
 */
function buildBackgroundBlock(threads: Array<{ arc: PlotArc; node: PlotNode }>, L: PlotPromptLabels): string {
  if (threads.length === 0) return '';
  const lines = threads.map(({ arc, node }) => fmt(L.plotBackgroundLine, {
    title: arc.title,
    node: node.title,
    goal: node.narrativeGoal ? L.plotBackgroundGoalSep + node.narrativeGoal : '',
    gauges: arc.gauges.length ? L.plotBackgroundGaugeSep + buildGaugeCompact(arc.gauges) : '',
  }));
  return ['', L.plotBackgroundHeader, ...lines, L.plotBackgroundHint].join('\n');
}

/**
 * Step 2 gauge update instructions — exact field names + format. Uses gauge
 * NAME (not internal id) so the model can match what it saw in Step 1. With
 * several active threads, gauges are grouped per thread and the model is told
 * to put each `gauge_updates` inside that thread's verdict item (§8.4 ④).
 */
function buildGaugeInstructions(threads: Array<{ arc: PlotArc; node: PlotNode }>, L: PlotPromptLabels): string {
  const withUpdatable = threads.filter(t => t.arc.gauges.some(g => g.aiUpdatable));
  if (withUpdatable.length === 0) return '';
  const multi = threads.length > 1;

  const lines: string[] = [multi ? L.plotGaugeInstrHeaderMulti : L.plotGaugeInstrHeader];
  for (const { arc } of withUpdatable) {
    if (multi) lines.push(fmt(L.plotGaugeInstrThread, { title: arc.title }));
    for (const g of arc.gauges.filter(x => x.aiUpdatable)) {
      lines.push(fmt(L.plotGaugeInstrLine, {
        name: g.name, current: g.current, max: g.max, unit: g.unit,
        desc: g.description ? L.plotGaugeDescSep + g.description : '',
      }));
    }
  }
  lines.push('', L.plotGaugeInstrFormat, L.plotGaugeInstrNote);

  const managed = threads.flatMap(t => t.arc.gauges.filter(g => !g.aiUpdatable));
  if (managed.length > 0) {
    lines.push(fmt(L.plotGaugeInstrManaged, { names: managed.map(g => g.name).join(', ') }));
  }
  return lines.join('\n');
}

/**
 * Evaluation context — one block per active thread: thread name, current node,
 * what that node is, and its completion hint. Listing every thread in ONE
 * place lets the model disambiguate evidence between threads while still
 * judging each independently (design §8.3 example 2).
 */
function buildEvalContext(threads: Array<{ arc: PlotArc; node: PlotNode }>, L: PlotPromptLabels): string {
  return threads.map(({ arc, node }, i) => {
    const lines: string[] = [
      threads.length > 1
        ? fmt(L.plotEvalThreadHeader, { index: i + 1, title: arc.title })
        : fmt(L.plotArcLabel, { title: arc.title }),
      fmt(L.plotEvalNodeLabel, { title: node.title }),
    ];
    if (node.narrativeGoal) lines.push(fmt(L.plotEvalEventLabel, { text: node.narrativeGoal }));
    lines.push(fmt(L.plotEvalHintLabel, { text: node.completionHint }));
    return lines.join('\n');
  }).join('\n\n');
}

// ═══════════════════════════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════════════════════════

export class PlotInjector {
  /**
   * Step 1 variables. `PLOT_DIRECTIVE` is the FOCUS thread in full (D2);
   * `PLOT_BACKGROUND_THREADS` is one line per other active thread. The
   * individual sub-variables (GAP-14) are also exposed so pack authors can
   * rearrange `plotDirective.md` without losing information.
   * @param fragments `GamePack.engineFragments` — supplies locale-specific labels.
   */
  static buildStep1Variables(
    stateManager: StateManager,
    paths: EnginePathConfig,
    fragments?: Record<string, unknown>,
  ): Record<string, string> {
    const state = stateManager.get<PlotDirectionState>(paths.plotDirection);
    const arc = getActiveArc(state);
    if (!arc) return {};
    const node = getActiveNode(arc);
    if (!node) return {};
    const L = resolvePlotLabels(fragments);
    const round = stateManager.get<number>(paths.roundNumber) ?? 0;
    const background = getActiveThreads(state).filter(t => t.arc.id !== arc.id);
    const next = getNextPendingNode(arc, node);

    return {
      PLOT_DIRECTIVE: buildDirectiveBlock(arc, node, round, L),
      PLOT_BACKGROUND_THREADS: buildBackgroundBlock(background, L),
      // GAP-14 sub-variables
      PLOT_FOCUS_TITLE: arc.title,
      PLOT_ARC_TITLE: arc.title,
      PLOT_NODE_TITLE: node.title,
      PLOT_NODE_DIRECTIVE: node.directive,
      PLOT_NODE_PREMISE: node.premise ?? '',
      PLOT_NODE_STAKES: node.stakes ?? '',
      PLOT_EMOTIONAL_TONE: node.emotionalTone ?? '',
      PLOT_GAUGES: buildGaugeCompact(arc.gauges),
      PLOT_OPPORTUNITY: getCurrentOpportunity(node, round),
      PLOT_COMPLETED_SUMMARY: buildCompletedSummary(arc, L),
      PLOT_IS_FIRST_ROUND: node.activatedAtRound === round ? 'true' : '',
      PLOT_NEXT_NODE_TITLE: next?.title ?? '',
      PLOT_NEXT_NODE_GOAL: next ? (next.narrativeGoal || next.premise || '') : '',
    };
  }

  /**
   * Step 2 variables cover EVERY active thread (joint context, independent
   * verdicts — design §8). `PLOT_COMPLETION_HINT` doubles as the flow
   * condition flag; with several threads it carries all hints joined.
   */
  static buildStep2Variables(
    stateManager: StateManager,
    paths: EnginePathConfig,
    fragments?: Record<string, unknown>,
  ): Record<string, string> {
    const state = stateManager.get<PlotDirectionState>(paths.plotDirection);
    const threads = getActiveThreads(state);
    if (threads.length === 0) return {};
    const L = resolvePlotLabels(fragments);

    return {
      PLOT_EVAL_CONTEXT: buildEvalContext(threads, L),
      PLOT_COMPLETION_HINT: threads.map(t => t.node.completionHint).filter(Boolean).join(L.plotHintJoinSep) || threads[0].node.title,
      PLOT_THREAD_COUNT: String(threads.length),
      PLOT_THREAD_TITLES: threads.map(t => t.arc.title).join(L.plotThreadTitleSep),
      PLOT_GAUGE_INSTRUCTIONS: buildGaugeInstructions(threads, L),
    };
  }

  static buildAllVariables(
    stateManager: StateManager,
    paths: EnginePathConfig,
    fragments?: Record<string, unknown>,
  ): Record<string, string> {
    return {
      ...PlotInjector.buildStep1Variables(stateManager, paths, fragments),
      ...PlotInjector.buildStep2Variables(stateManager, paths, fragments),
    };
  }
}
