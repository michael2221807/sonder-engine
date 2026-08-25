// App doc: docs/user-guide/pages/game-plot.md §弹窗 7：续写 / 改写 · §弹窗 3 AI 重写
// Design: docs/design/plot-arc-revise-extend.md §3.2/§3.3 (AI contract + engine)
/**
 * Plot Revise & Extend — AI-assisted revision of one existing thread.
 *
 * The player asks for a continuation or rewrite; ONE call returns a full
 * replacement of the thread's pending region (plus optional synopsis /
 * active-node text updates / gauge list). Completed and skipped nodes are
 * rendered as immutable facts; seam continuity is a prompt-level obligation
 * (§5.2 — the correction happens inside this same call, never a second one).
 *
 * All human-readable scaffolding comes from `GamePack.engineFragments`
 * (`plotRev*` keys) so the engine never hardcodes prompt language.
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { GamePack } from '../types';
import type { PlotArc, PlotNode, PlotDirectionState } from './types';
import type { PlotDecomposer, DecomposeResult, DecomposeOptions } from './plot-decomposer';

/** The six text fields the AI may update on the in-progress node (D1: content yes, progress no). */
export const ACTIVE_NODE_UPDATE_FIELDS = [
  'directive', 'narrativeGoal', 'completionHint', 'premise', 'stakes', 'emotionalTone',
] as const;
export type ActiveNodeUpdate = Partial<Pick<PlotNode, (typeof ACTIVE_NODE_UPDATE_FIELDS)[number]>>;

/**
 * One gauge in the AI's full-replacement list. Only `name` is required —
 * omitted fields mean "keep the existing value" for a kept gauge and take
 * decomposer defaults for a new one. `current` is honoured ONLY when the
 * model emitted it explicitly (played-out values must survive a rewrite, D4).
 */
export interface ReviseGauge {
  name: string;
  description?: string;
  min?: number;
  max?: number;
  unit?: string;
  color?: string;
  showInMainPanel?: boolean;
  aiUpdatable?: boolean;
  maxDeltaPerRound?: number;
  autoDecrement?: number;
  initialValue?: number;
  current?: number;
}

export interface ReviseResult {
  synopsis?: string;
  activeNodeUpdate?: ActiveNodeUpdate;
  /** Full replacement of the pending region (may be empty = cut the future). */
  nodes: DecomposeResult['nodes'];
  /** Full replacement of the thread's gauge list. */
  gauges: ReviseGauge[];
}

/** One link of the chain shown to the single-node rewrite call (preview state, not the store). */
export interface ReviseNodeChainItem {
  title: string;
  premise?: string;
  narrativeGoal?: string;
  directive?: string;
  stakes?: string;
  completionHint?: string;
  emotionalTone?: string;
  importance?: string;
  maxRounds?: number;
  /** done = already happened (immutable, evidence shown); active = in progress; planned = proposal node. */
  kind: 'done' | 'active' | 'planned';
  evidence?: string;
}

export interface ReviseOptions extends DecomposeOptions {
  /**
   * Player's per-run choice (UI switch): may the AI touch the in-progress
   * node's text fields this time? Default true (decision D1). When false the
   * node is rendered with the immutable marker AND any `active_node_update`
   * in the reply is discarded — belt and braces.
   */
  allowActiveNodeUpdate?: boolean;
}

const DEFAULT_REV_LABELS = {
  plotRevArcHeader: '## 目标剧情线《{title}》[{status}]',
  plotRevSynopsisLine: '概要：{text}',
  plotRevMarkImmutable: '【已发生·不可修改】',
  plotRevMarkActive: '【正在进行】',
  plotRevMarkPending: '【可改写】',
  plotRevMarkPlanned: '【计划中·不可改动】',
  plotRevMarkTarget: '【要改的节点】',
  plotRevNodeLine: '{marker}《{title}》',
  plotRevFieldPremise: '  承接：{text}',
  plotRevFieldGoal: '  事件：{text}',
  plotRevFieldDirective: '  引导：{text}',
  plotRevFieldStakes: '  改变：{text}',
  plotRevFieldHint: '  完成标志：{text}',
  plotRevFieldTone: '  基调：{text}',
  plotRevFieldEvidence: '  完成证据：{text}',
  plotRevFieldMeta: '  importance: {importance} · maxRounds: {maxRounds}',
  plotRevGaugesHeader: '## 该线现有度量值（当前值是玩出来的运行时事实）',
  plotRevGaugeLine: '- {name}（{min}-{max}{unit}）当前 {current}{desc}',
  plotRevGaugeDescSep: ' — ',
  plotRevGaugesEmpty: '（无）',
} satisfies Record<string, string>;

type RevLabels = { [K in keyof typeof DEFAULT_REV_LABELS]: string };

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : ''));
}

export class PlotReviser {
  constructor(
    private decomposer: PlotDecomposer,
    private stateManager: StateManager,
    private pack: GamePack,
    private paths: EnginePathConfig,
  ) {}

  private labels(): RevLabels {
    const out: RevLabels = { ...DEFAULT_REV_LABELS };
    const frags = this.pack.engineFragments;
    if (!frags) return out;
    for (const key of Object.keys(DEFAULT_REV_LABELS) as Array<keyof RevLabels>) {
      const v = frags[key];
      if (typeof v === 'string') out[key] = v;
    }
    return out;
  }

  /**
   * One revision call for `arcId`. Returns null when the thread is not
   * revisable (completed/abandoned/missing — the UI hides the entry, this is
   * the engine-side backstop), the prompt is missing, or the model's answer
   * is unusable.
   */
  async revise(arcId: string, request: string, opts: ReviseOptions = {}): Promise<ReviseResult | null> {
    const promptContent = this.pack.prompts?.['plotRevise'] ?? '';
    if (!promptContent) {
      console.warn('[PlotReviser] plotRevise prompt not found in pack');
      return null;
    }
    const state = this.stateManager.get<PlotDirectionState>(this.paths.plotDirection);
    const arc = state?.arcs.find(a => a.id === arcId);
    if (!arc || (arc.status !== 'draft' && arc.status !== 'scheduled' && arc.status !== 'active')) {
      console.warn(`[PlotReviser] thread ${arcId} is not revisable`);
      return null;
    }

    const allowActive = opts.allowActiveNodeUpdate ?? true;
    const result = await this.decomposer.invoke(promptContent, request, {
      PLOT_REVISE_REQUEST: request,
      PLOT_REVISE_ARC: this.renderArc(arc, allowActive),
      PLOT_REVISE_GAUGES: this.renderGauges(arc),
      PLOT_CONTEXT: this.decomposer.buildContext(),
    }, opts);
    if (!result) return null;
    if (!Array.isArray(result['nodes'])) {
      console.warn('[PlotReviser] AI response missing nodes array');
      return null;
    }

    const synopsis = typeof result['synopsis'] === 'string' && result['synopsis'].trim()
      ? result['synopsis'].trim()
      : undefined;
    const activeNodeUpdate = allowActive
      ? this.parseActiveNodeUpdate(result['active_node_update'])
      : undefined;
    return {
      ...(synopsis ? { synopsis } : {}),
      ...(activeNodeUpdate ? { activeNodeUpdate } : {}),
      // ONLY the `gauges` key — `suggested_gauges` (the decompose flows' key)
      // has ADDITIVE semantics there; honouring it here would misread "add
      // these" as a full-replacement list and wipe every unnamed gauge.
      nodes: this.decomposer.normalizeNodes(result['nodes'] as unknown[]),
      gauges: this.parseGauges(result['gauges']),
    };
  }

  /**
   * Rewrite ONE node of a chain to the player's request (user decision
   * 2026-08-24: a dedicated call that sees the surrounding nodes so the arc
   * stays coherent). The chain is either preview state (proposal nodes as
   * `planned`) or the real thread (pending nodes as `planned`, the in-progress
   * one as `active`) — history renders immutable with its evidence, other
   * not-yet-done nodes render as fixed context, only the target is marked
   * rewritable. Targets may be `planned` or `active` (an in-progress node's
   * content may be redirected, D1); `done` nodes are history and are refused.
   * Returns the replacement node or null (bad target / missing prompt /
   * unusable reply).
   */
  async reviseNode(
    arc: Pick<PlotArc, 'title' | 'synopsis' | 'status'>,
    chain: ReviseNodeChainItem[],
    targetIndex: number,
    request: string,
    opts: DecomposeOptions = {},
  ): Promise<DecomposeResult['nodes'][number] | null> {
    const promptContent = this.pack.prompts?.['plotReviseNode'] ?? '';
    if (!promptContent) {
      console.warn('[PlotReviser] plotReviseNode prompt not found in pack');
      return null;
    }
    const target = chain[targetIndex];
    if (!target || target.kind === 'done') {
      console.warn(`[PlotReviser] reviseNode target ${targetIndex} is not rewritable`);
      return null;
    }

    const result = await this.decomposer.invoke(promptContent, request, {
      PLOT_NODE_REQUEST: request,
      PLOT_NODE_CHAIN: this.renderChain(arc, chain, targetIndex),
      PLOT_CONTEXT: this.decomposer.buildContext(),
    }, opts);
    if (!result) return null;

    const raw = result['node'] ?? (Array.isArray(result['nodes']) ? (result['nodes'] as unknown[])[0] : undefined);
    if (!raw || typeof raw !== 'object') {
      console.warn('[PlotReviser] AI response missing the rewritten node');
      return null;
    }
    return this.decomposer.normalizeNodes([raw])[0] ?? null;
  }

  // ─── Rendering ───

  /** The full chain, every content field visible; only the target is marked rewritable. */
  private renderChain(
    arc: Pick<PlotArc, 'title' | 'synopsis' | 'status'>,
    chain: ReviseNodeChainItem[],
    targetIndex: number,
  ): string {
    const L = this.labels();
    const lines: string[] = [fmt(L.plotRevArcHeader, { title: arc.title, status: arc.status })];
    if (arc.synopsis) lines.push(fmt(L.plotRevSynopsisLine, { text: arc.synopsis }));
    chain.forEach((n, i) => {
      // A non-target in-progress node is fixed context but has NOT happened —
      // its own marker, never the "already happened" one (review 2026-08-24 M4).
      const marker = i === targetIndex ? L.plotRevMarkTarget
        : n.kind === 'planned' ? L.plotRevMarkPlanned
        : n.kind === 'active' ? L.plotRevMarkActive
        : L.plotRevMarkImmutable;
      lines.push(fmt(L.plotRevNodeLine, { marker, title: n.title }));
      if (n.premise) lines.push(fmt(L.plotRevFieldPremise, { text: n.premise }));
      if (n.narrativeGoal) lines.push(fmt(L.plotRevFieldGoal, { text: n.narrativeGoal }));
      if (n.kind !== 'done') {
        if (n.directive) lines.push(fmt(L.plotRevFieldDirective, { text: n.directive }));
        if (n.stakes) lines.push(fmt(L.plotRevFieldStakes, { text: n.stakes }));
        if (n.completionHint) lines.push(fmt(L.plotRevFieldHint, { text: n.completionHint }));
        if (n.emotionalTone) lines.push(fmt(L.plotRevFieldTone, { text: n.emotionalTone }));
        lines.push(fmt(L.plotRevFieldMeta, { importance: n.importance ?? 'critical', maxRounds: n.maxRounds ?? 6 }));
      }
      if (n.evidence) lines.push(fmt(L.plotRevFieldEvidence, { text: n.evidence }));
    });
    return lines.join('\n');
  }

  /** Every content field is rendered — the AI can only preserve what it can see (§3.2). */
  private renderArc(arc: PlotArc, allowActiveNodeUpdate: boolean): string {
    const L = this.labels();
    const lines: string[] = [fmt(L.plotRevArcHeader, { title: arc.title, status: arc.status })];
    if (arc.synopsis) lines.push(fmt(L.plotRevSynopsisLine, { text: arc.synopsis }));
    for (const n of arc.nodes) {
      // With the per-run switch off, the in-progress node presents as immutable
      // context — the prompt's [in progress] rule then has nothing to bind to.
      const marker = n.status === 'active' ? (allowActiveNodeUpdate ? L.plotRevMarkActive : L.plotRevMarkImmutable)
        : n.status === 'pending' ? L.plotRevMarkPending
        : L.plotRevMarkImmutable;
      lines.push(fmt(L.plotRevNodeLine, { marker, title: n.title }));
      if (n.premise) lines.push(fmt(L.plotRevFieldPremise, { text: n.premise }));
      if (n.narrativeGoal) lines.push(fmt(L.plotRevFieldGoal, { text: n.narrativeGoal }));
      if (n.status !== 'completed' && n.status !== 'skipped') {
        if (n.directive) lines.push(fmt(L.plotRevFieldDirective, { text: n.directive }));
        if (n.stakes) lines.push(fmt(L.plotRevFieldStakes, { text: n.stakes }));
        if (n.completionHint) lines.push(fmt(L.plotRevFieldHint, { text: n.completionHint }));
        if (n.emotionalTone) lines.push(fmt(L.plotRevFieldTone, { text: n.emotionalTone }));
        lines.push(fmt(L.plotRevFieldMeta, { importance: n.importance, maxRounds: n.maxRounds ?? 6 }));
      }
      if (n.completionEvidence) lines.push(fmt(L.plotRevFieldEvidence, { text: n.completionEvidence }));
    }
    return lines.join('\n');
  }

  private renderGauges(arc: PlotArc): string {
    const L = this.labels();
    const lines: string[] = [L.plotRevGaugesHeader];
    if (arc.gauges.length === 0) {
      lines.push(L.plotRevGaugesEmpty);
    } else {
      for (const g of arc.gauges) {
        lines.push(fmt(L.plotRevGaugeLine, {
          name: g.name, min: g.min, max: g.max, unit: g.unit, current: g.current,
          desc: g.description ? L.plotRevGaugeDescSep + g.description : '',
        }));
      }
    }
    return lines.join('\n');
  }

  // ─── Parsing ───

  private parseActiveNodeUpdate(raw: unknown): ActiveNodeUpdate | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const obj = raw as Record<string, unknown>;
    const out: ActiveNodeUpdate = {};
    for (const key of ACTIVE_NODE_UPDATE_FIELDS) {
      const snake = key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
      const v = obj[key] ?? obj[snake];
      if (typeof v === 'string' && v.trim()) out[key] = v.trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private parseGauges(raw: unknown): ReviseGauge[] {
    if (!Array.isArray(raw)) return [];
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item): ReviseGauge => ({
        name: String(item['name'] ?? '').trim(),
        description: typeof item['description'] === 'string' ? item['description'] : undefined,
        min: num(item['min']),
        max: num(item['max']),
        unit: typeof item['unit'] === 'string' ? item['unit'] : undefined,
        color: typeof item['color'] === 'string' ? item['color'] : undefined,
        showInMainPanel: bool(item['showInMainPanel']),
        aiUpdatable: bool(item['aiUpdatable']),
        maxDeltaPerRound: num(item['maxDeltaPerRound']),
        autoDecrement: num(item['autoDecrement']),
        initialValue: num(item['initialValue'] ?? item['initial_value']),
        current: num(item['current']),
      }))
      .filter(g => g.name);
  }
}
