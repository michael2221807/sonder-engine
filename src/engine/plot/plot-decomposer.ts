// Design: docs/design/plot-direction-system.md
// Design (threads): docs/design/plot-parallel-threads-scheduler.md §7 (narrative-first context, §7.4 multi-thread)
// App doc: docs/user-guide/pages/game-plot.md §弹窗 1：创建弧线
/**
 * Plot Direction System — AI-Assisted Outline Decomposition
 *
 * Takes a natural-language outline from the player and calls the LLM to
 * decompose it into a structured PlotNode chain + suggested gauges (single
 * thread), or into several threads with their sequencing triggers (multi).
 *
 * The context the model sees is PLOT-FIRST (design §7.2): ① the plot ledger
 * (every thread's nodes + completion evidence) ② world facts (event log +
 * Canon world books) ③ memory ④ a name-level state appendix. The full state
 * tree is deliberately NOT dumped any more — that is what made earlier
 * decompositions character-centric.
 *
 * All human-readable scaffolding comes from `GamePack.engineFragments`
 * (`plotCtx*` keys) so the engine never hardcodes prompt language.
 */
import type { AIService } from '../ai/ai-service';
import type { ResponseParser } from '../ai/response-parser';
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';
import type { GamePack } from '../types';
import type { WorldBook } from '../prompt/world-book';
import type { PlotNode, PlotGauge, OpportunityTier, PlotArc, PlotDirectionState, ThreadActivation, ThreadTrigger } from './types';
import { DEFAULT_GAUGE_MAX_DELTA, DEFAULT_MAX_ACTIVE_THREADS } from './types';
import { buildEnvironmentBlock } from '../prompt/environment-block';
import { buildNarrativeContractFromState } from '../prompt/narrative-contract';
import { readGameTimeStamp } from './game-time-stamp';

export interface DecomposeResult {
  nodes: Omit<PlotNode, 'id' | 'arcId' | 'status' | 'consecutiveReachedCount' | 'activatedAtRound' | 'completedAtRound'>[];
  suggestedGauges: Omit<PlotGauge, 'id' | 'lastAutoDecrementRound' | 'boundaryFiredAtRound'>[];
}

/** How the model references another thread before ids exist (resolved at commit time). */
export type ThreadActivationRef =
  | { after_thread: string }
  | { after_node: string }
  | { at_round: number };

export interface DecomposedThread extends DecomposeResult {
  title: string;
  synopsis: string;
  color?: string;
  /** `null` = starts immediately (counts against `maxActiveThreads`). */
  activation: ThreadActivationRef[] | null;
  /** Refs the model emitted in a shape we could not read (e.g. `at_round: "30"`) — surfaced, never silently dropped. */
  malformedRefs: string[];
}

export interface MultiDecomposeResult {
  threads: DecomposedThread[];
}

export interface DecomposeOptions {
  signal?: AbortSignal;
  /** Concurrency cap shown to the model (multi mode only). */
  maxActiveThreads?: number;
}

/** Result of resolving title-based refs into id-based triggers after the arcs exist. */
export interface ResolvedThreadActivation {
  activation: ThreadActivation | null;
  /** Refs that named a thread/node that does not exist — the thread should land as `draft`. */
  unresolved: string[];
}

const DEFAULT_CTX_LABELS = {
  plotCtxLedgerHeader: '## ① 剧情账本（已有剧情线，新剧情必须承接这里的事实）',
  plotCtxLedgerEmpty: '（尚无剧情线）',
  plotCtxThreadLine: '《{title}》[{status}]',
  plotCtxNodeLine: '  {icon} {title}{range}{note}',
  plotCtxNodeEvidenceSep: ' — ',
  plotCtxWorldFactsHeader: '## ② 世界事实',
  plotCtxEventsLabel: '### 事件记录（最近）',
  plotCtxEventLine: '- R{round} {title}：{description}',
  plotCtxCanonLabel: '### 设定集',
  plotCtxCanonEntry: '- {title}：{content}',
  plotCtxWorldFactsEmpty: '（暂无事件与设定记录）',
  plotCtxMemoryHeader: '## ③ 记忆摘要',
  plotCtxLongTermLabel: '### 长期记忆',
  plotCtxMidTermLabel: '### 中期记忆（最近）',
  plotCtxMemoryEmpty: '（暂无记忆）',
  plotCtxStateHeader: '## ④ 状态附录（仅供对齐名字，不要围绕它设计情节）',
  plotCtxWorldLine: '世界：{text}',
  plotCtxWhereLine: '主角：{player} · 位置：{location} · 回合：{round}{time}',
  plotCtxTimeSep: ' · 时间：',
  plotCtxNpcLabel: '在场人物（名字·身份）：',
  plotCtxNpcLine: '- {name}{type}{desc}',
  plotCtxSummaryLine: '玩家：{player}，当前位置：{location}，回合：{round}',
} satisfies Record<string, string>;

type CtxLabels = { [K in keyof typeof DEFAULT_CTX_LABELS]: string };

function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : ''));
}
function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

const NODE_ICON: Record<PlotNode['status'], string> = { completed: '✓', active: '●', pending: '○', skipped: '⏭' };
const MAX_EVENTS = 10;
const MAX_CANON_CHARS = 2000;
const MAX_EVIDENCE = 80;
const MAX_LEDGER_ARCS = 8;
const MAX_LEDGER_NODES = 12;

export class PlotDecomposer {
  constructor(
    private aiService: AIService,
    private responseParser: ResponseParser,
    private stateManager: StateManager,
    private pack: GamePack,
    private paths: EnginePathConfig,
  ) {}

  private labels(): CtxLabels {
    const out: CtxLabels = { ...DEFAULT_CTX_LABELS };
    const frags = this.pack.engineFragments;
    if (!frags) return out;
    for (const key of Object.keys(DEFAULT_CTX_LABELS) as Array<keyof CtxLabels>) {
      const v = frags[key];
      if (typeof v === 'string') out[key] = v;
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  //  Single thread
  // ═══════════════════════════════════════════════════════════════

  async decompose(outline: string, signalOrOpts?: AbortSignal | DecomposeOptions): Promise<DecomposeResult | null> {
    const opts = this.toOpts(signalOrOpts);
    const promptContent = this.pack.prompts?.['plotDecompose'] ?? '';
    if (!promptContent) {
      console.warn('[PlotDecomposer] plotDecompose prompt not found in pack');
      return null;
    }
    const result = await this.callModel(promptContent, outline, opts);
    if (!result) return null;
    if (!Array.isArray(result['nodes'])) {
      console.warn('[PlotDecomposer] AI response missing nodes array');
      return null;
    }
    return {
      nodes: this.normalizeNodes(result['nodes'] as unknown[]),
      suggestedGauges: this.normalizeGauges((result['suggested_gauges'] ?? result['suggestedGauges'] ?? []) as unknown[]),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Multi thread (§7.4) — ONE call returns every thread with its sequencing
  // ═══════════════════════════════════════════════════════════════

  async decomposeThreads(outline: string, opts: DecomposeOptions = {}): Promise<MultiDecomposeResult | null> {
    const promptContent = this.pack.prompts?.['plotDecomposeThreads'] ?? '';
    if (!promptContent) {
      console.warn('[PlotDecomposer] plotDecomposeThreads prompt not found in pack');
      return null;
    }
    const result = await this.callModel(promptContent, outline, opts);
    if (!result) return null;
    const raw = result['threads'];
    if (!Array.isArray(raw)) {
      console.warn('[PlotDecomposer] AI response missing threads array');
      return null;
    }
    const threads = raw
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
      .map((t): DecomposedThread => {
        const { refs, malformed } = this.normalizeActivationRefs(t['activation']);
        return {
        title: String(t['title'] ?? '').trim(),
        synopsis: String(t['synopsis'] ?? '').trim(),
        color: typeof t['color'] === 'string' ? t['color'] : undefined,
        activation: refs,
        malformedRefs: malformed,
        nodes: this.normalizeNodes(Array.isArray(t['nodes']) ? t['nodes'] : []),
        suggestedGauges: this.normalizeGauges(Array.isArray(t['gauges']) ? t['gauges'] : Array.isArray(t['suggested_gauges']) ? t['suggested_gauges'] : []),
        };
      })
      .filter(t => t.title && t.nodes.length > 0);
    if (threads.length === 0) {
      console.warn('[PlotDecomposer] no usable threads in AI response');
      return null;
    }
    return { threads };
  }

  /**
   * Turn title-based refs into id-based triggers once the arcs exist.
   * Pure — exported for tests and for the UI commit step.
   */
  static resolveThreadActivation(
    refs: ThreadActivationRef[] | null,
    created: Array<Pick<PlotArc, 'id' | 'title' | 'nodes'>>,
  ): ResolvedThreadActivation {
    if (!refs || refs.length === 0) return { activation: null, unresolved: [] };
    const triggers: ThreadTrigger[] = [];
    const unresolved: string[] = [];
    const findArc = (title: string) => created.find(a => a.title.trim() === title.trim());
    for (const ref of refs) {
      if ('at_round' in ref) {
        if (Number.isFinite(ref.at_round) && ref.at_round >= 1) triggers.push({ type: 'round_reached', round: Math.round(ref.at_round) });
        else unresolved.push(`at_round:${String(ref.at_round)}`);
      } else if ('after_thread' in ref) {
        const arc = findArc(ref.after_thread);
        if (arc) triggers.push({ type: 'thread_completed', arcId: arc.id });
        else unresolved.push(ref.after_thread);
      } else {
        const [threadTitle, nodeTitle] = ref.after_node.split('/').map(s => s.trim());
        const arc = threadTitle ? findArc(threadTitle) : undefined;
        const node = arc?.nodes.find(n => n.title.trim() === nodeTitle);
        if (arc && node) triggers.push({ type: 'node_completed', arcId: arc.id, nodeId: node.id });
        else unresolved.push(ref.after_node);
      }
    }
    return { activation: triggers.length > 0 ? { mode: 'auto', triggers } : null, unresolved };
  }

  // ═══════════════════════════════════════════════════════════════
  //  Shared call + context
  // ═══════════════════════════════════════════════════════════════

  private toOpts(v?: AbortSignal | DecomposeOptions): DecomposeOptions {
    if (!v) return {};
    return v instanceof AbortSignal ? { signal: v } : v;
  }

  private async callModel(promptContent: string, outline: string, opts: DecomposeOptions): Promise<Record<string, unknown> | null> {
    const maxActive = opts.maxActiveThreads
      ?? this.stateManager.get<number>('系统.设置.plot.maxActiveThreads')
      ?? DEFAULT_MAX_ACTIVE_THREADS;
    return this.invoke(promptContent, outline, {
      PLOT_OUTLINE: outline,
      // Legacy placeholder: the shipped templates use PLOT_CONTEXT, but user-edited
      // prompt overrides from Sprint Plot-1 may still reference PLOT_STATE_SUMMARY.
      PLOT_STATE_SUMMARY: this.buildStateSummary(),
      PLOT_CONTEXT: this.buildContext(),
      PLOT_MAX_ACTIVE: String(maxActive),
    }, opts);
  }

  /**
   * Render `vars` into a pack prompt and run one `plot_decompose`-typed call
   * (jailbreak + system + user, JSON fallback parsing). Shared by the
   * decomposition modes and by PlotReviser (plot-arc-revise-extend §3.3).
   */
  async invoke(
    promptContent: string,
    userMessage: string,
    vars: Record<string, string>,
    opts: DecomposeOptions,
  ): Promise<Record<string, unknown> | null> {
    const rendered = promptContent.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (k in vars ? vars[k] : ''));

    const messages: { role: 'system' | 'user'; content: string }[] = [];
    // Jailbreak — always inject as first system message (same pattern as assistant-service)
    const jailbreak = this.pack.prompts?.['assistantJailbreak']?.trim();
    if (jailbreak) messages.push({ role: 'system', content: jailbreak });
    messages.push({ role: 'system', content: rendered });
    messages.push({ role: 'user', content: userMessage });

    try {
      const rawResponse = await this.aiService.generate({ messages, usageType: 'plot_decompose', signal: opts.signal });
      const parsed = this.responseParser.parse(rawResponse);
      let result = (parsed.customFields ?? {}) as Record<string, unknown>;
      if (!result['nodes'] && !result['threads'] && parsed.text) {
        try {
          result = JSON.parse(parsed.text) as Record<string, unknown>;
        } catch {
          const match = parsed.text.match(/```json\s*([\s\S]*?)```/) ?? parsed.text.match(/```json\s*([\s\S]+)/);
          if (match) {
            try { result = JSON.parse(match[1]) as Record<string, unknown>; }
            catch (innerErr) { console.warn('[PlotDecomposer] Failed to parse JSON from code block:', innerErr); }
          }
        }
      }
      return result;
    } catch (err) {
      if (opts.signal?.aborted) return null;
      console.error('[PlotDecomposer] Decomposition failed:', err);
      return null;
    }
  }

  private buildStateSummary(): string {
    const L = this.labels();
    return fmt(L.plotCtxSummaryLine, {
      player: this.stateManager.get<string>(this.paths.playerName) ?? '',
      location: this.stateManager.get<string>(this.paths.playerLocation) ?? '',
      round: this.stateManager.get<number>(this.paths.roundNumber) ?? 0,
    });
  }

  /**
   * §7.2 — four sections, in priority order, preceded by the player's Narrative
   * Contract when this save has one (R2 second batch, 2026-09-05): nodes decomposed
   * without the melody produced "task-shaped" beats that contradicted it (P3 86-乙).
   * Empty contract → nothing prepended, context byte-identical to before.
   */
  buildContext(): string {
    const L = this.labels();
    const { block: contractBlock } = buildNarrativeContractFromState(this.stateManager, this.paths, this.pack.engineFragments);
    return [
      contractBlock,
      this.buildLedger(L),
      this.buildWorldFacts(L),
      this.buildMemoryBlock(L),
      this.buildStateAppendix(L),
    ].filter(Boolean).join('\n\n');
  }

  private buildLedger(L: CtxLabels): string {
    const state = this.stateManager.get<PlotDirectionState>(this.paths.plotDirection);
    // Abandoned threads are not facts the new plot should build on; drafts are
    // listed so the model does not propose duplicates. Bounded for long saves.
    const arcs = (state?.arcs ?? []).filter(a => a.status !== 'abandoned').slice(-MAX_LEDGER_ARCS);
    const lines: string[] = [L.plotCtxLedgerHeader];
    if (arcs.length === 0) {
      lines.push(L.plotCtxLedgerEmpty);
      return lines.join('\n');
    }
    for (const arc of arcs) {
      lines.push(fmt(L.plotCtxThreadLine, { title: arc.title, status: arc.status }));
      for (const n of arc.nodes.slice(-MAX_LEDGER_NODES)) {
        const range = n.activatedAtRound != null
          ? ` (R${n.activatedAtRound}${n.completedAtRound != null ? `–R${n.completedAtRound}` : '…'})`
          : '';
        const note = n.completionEvidence
          ? L.plotCtxNodeEvidenceSep + clip(n.completionEvidence, MAX_EVIDENCE)
          : (n.narrativeGoal ? L.plotCtxNodeEvidenceSep + clip(n.narrativeGoal, MAX_EVIDENCE) : '');
        lines.push(fmt(L.plotCtxNodeLine, { icon: NODE_ICON[n.status], title: n.title, range, note }));
      }
    }
    return lines.join('\n');
  }

  private buildWorldFacts(L: CtxLabels): string {
    const lines: string[] = [L.plotCtxWorldFactsHeader];
    const events = (this.stateManager.get<Array<Record<string, unknown>>>(this.paths.worldEvents) ?? []).slice(-MAX_EVENTS);
    if (events.length > 0) {
      lines.push(L.plotCtxEventsLabel);
      for (const e of events) {
        // EventPanel contract field names (see plot-evaluation-pipeline.fireNodeEvent / GAP-13)
        lines.push(fmt(L.plotCtxEventLine, {
          round: typeof e['回合'] === 'number' ? e['回合'] : '?',
          title: String(e['事件名称'] ?? e['title'] ?? ''),
          description: clip(String(e['事件描述'] ?? e['description'] ?? ''), 120),
        }));
      }
    }
    const books = this.stateManager.get<WorldBook[]>(this.paths.slotWorldBooks) ?? [];
    let budget = MAX_CANON_CHARS;
    const canon: string[] = [];
    for (const book of books) {
      if (book.enabled === false) continue;
      const entries = [...book.entries]
        .filter(e => e.enabled !== false && (e.content ?? '').trim())
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      for (const e of entries) {
        const line = fmt(L.plotCtxCanonEntry, { title: e.title, content: clip(e.content.trim(), 160) });
        if (line.length > budget) continue;
        canon.push(line);
        budget -= line.length;
      }
    }
    if (canon.length > 0) {
      lines.push(L.plotCtxCanonLabel, ...canon);
    }
    if (lines.length === 1) lines.push(L.plotCtxWorldFactsEmpty);
    return lines.join('\n');
  }

  private buildMemoryBlock(L: CtxLabels): string {
    const midTerm = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.memoryMidTerm) ?? [];
    const longTerm = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.memoryLongTerm) ?? [];
    const lines: string[] = [L.plotCtxMemoryHeader];
    if (longTerm.length > 0) {
      lines.push(L.plotCtxLongTermLabel);
      for (const entry of longTerm.slice(-10)) {
        const content = entry['记忆主体'] ?? entry['content'] ?? '';
        if (content) lines.push(`- ${String(content)}`);
      }
    }
    if (midTerm.length > 0) {
      lines.push(L.plotCtxMidTermLabel);
      for (const entry of midTerm.slice(-15)) {
        const content = entry['记忆主体'] ?? entry['content'] ?? '';
        if (content) lines.push(`- ${String(content)}`);
      }
    }
    if (lines.length === 1) lines.push(L.plotCtxMemoryEmpty);
    return lines.join('\n');
  }

  /** Name-level only — the full state tree is no longer dumped (§7.2 ④). */
  private buildStateAppendix(L: CtxLabels): string {
    const lines: string[] = [L.plotCtxStateHeader];
    const world = this.stateManager.get<string>(this.paths.worldDescription);
    if (world) lines.push(fmt(L.plotCtxWorldLine, { text: clip(world, 300) }));
    const stamp = readGameTimeStamp(this.stateManager, this.paths);
    const time = stamp ? [stamp.year, stamp.month, stamp.day].filter(v => v !== undefined).join('/') : '';
    lines.push(fmt(L.plotCtxWhereLine, {
      player: this.stateManager.get<string>(this.paths.playerName) ?? '',
      location: this.stateManager.get<string>(this.paths.playerLocation) ?? '',
      round: this.stateManager.get<number>(this.paths.roundNumber) ?? 0,
      time: time ? L.plotCtxTimeSep + time : '',
    }));
    const env = buildEnvironmentBlock({
      weather: this.stateManager.get<unknown>(this.paths.weather),
      festival: this.stateManager.get<unknown>(this.paths.festival),
      environment: this.stateManager.get<unknown>(this.paths.environmentTags),
    });
    if (env) lines.push(env);
    const npcs = this.stateManager.get<Array<Record<string, unknown>>>(this.paths.relationships) ?? [];
    const f = this.paths.npcFieldNames;
    if (npcs.length > 0 && f) {
      lines.push(L.plotCtxNpcLabel);
      for (const npc of npcs.slice(0, 20)) {
        const name = String(npc[f.name] ?? '');
        if (!name) continue;
        const type = npc[f.type] ? `·${String(npc[f.type])}` : '';
        const desc = npc[f.description] ? `：${clip(String(npc[f.description]), 40)}` : '';
        lines.push(fmt(L.plotCtxNpcLine, { name, type, desc }));
      }
    }
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  //  Normalisation
  // ═══════════════════════════════════════════════════════════════

  /**
   * `null` = no activation given (starts now). Unreadable refs are reported in
   * `malformed` so a fully-garbled activation never silently becomes "starts now".
   */
  private normalizeActivationRefs(raw: unknown): { refs: ThreadActivationRef[] | null; malformed: string[] } {
    if (raw == null) return { refs: null, malformed: [] };
    const items = Array.isArray(raw) ? raw : [raw];
    const out: ThreadActivationRef[] = [];
    const malformed: string[] = [];
    for (const item of items) {
      if (item === null || typeof item !== 'object') { malformed.push(String(item)); continue; }
      const r = item as Record<string, unknown>;
      const round = typeof r['at_round'] === 'number' ? r['at_round']
        : typeof r['at_round'] === 'string' && Number.isFinite(Number(r['at_round'])) ? Number(r['at_round']) : undefined;
      if (typeof r['after_thread'] === 'string' && r['after_thread'].trim()) out.push({ after_thread: r['after_thread'].trim() });
      else if (typeof r['after_node'] === 'string' && r['after_node'].trim()) out.push({ after_node: r['after_node'].trim() });
      else if (round !== undefined) out.push({ at_round: round });
      else malformed.push(JSON.stringify(r).slice(0, 60));
    }
    return { refs: out.length > 0 ? out : null, malformed };
  }

  /** Public: PlotReviser reuses the exact node contract (plot-arc-revise-extend §3.2). */
  normalizeNodes(raw: unknown[]): DecomposeResult['nodes'] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object')
      .map(item => ({
        title: String(item['title'] ?? ''),
        narrativeGoal: String(item['narrativeGoal'] ?? item['narrative_goal'] ?? ''),
        directive: String(item['directive'] ?? ''),
        completionHint: String(item['completionHint'] ?? item['completion_hint'] ?? ''),
        premise: typeof item['premise'] === 'string' ? item['premise'] : undefined,
        stakes: typeof item['stakes'] === 'string' ? item['stakes'] : undefined,
        completionConditions: [],
        completionMode: 'hint_only' as const,
        activationConditions: [],
        maxRounds: typeof item['maxRounds'] === 'number' ? item['maxRounds']
          : typeof item['max_rounds'] === 'number' ? item['max_rounds'] : 6,
        importance: item['importance'] === 'skippable' ? 'skippable' as const : 'critical' as const,
        opportunityTiers: this.normalizeOpportunityTiers(item['opportunityTiers'] ?? item['opportunity_tiers']),
        emotionalTone: typeof item['emotionalTone'] === 'string' ? item['emotionalTone']
          : typeof item['emotional_tone'] === 'string' ? item['emotional_tone'] : undefined,
      }))
      .filter(n => n.title.trim());
  }

  private normalizeOpportunityTiers(raw: unknown): OpportunityTier[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
      .map(t => ({
        tier: (typeof t['tier'] === 'number' ? t['tier'] : 1) as 1 | 2 | 3,
        afterRounds: typeof t['afterRounds'] === 'number' ? t['afterRounds']
          : typeof t['after_rounds'] === 'number' ? t['after_rounds'] : 3,
        prompt: String(t['prompt'] ?? ''),
      }));
  }

  private normalizeGauges(raw: unknown[]): DecomposeResult['suggestedGauges'] {
    return raw
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object')
      .map(item => ({
        name: String(item['name'] ?? ''),
        description: String(item['description'] ?? ''),
        min: typeof item['min'] === 'number' ? item['min'] : 0,
        max: typeof item['max'] === 'number' ? item['max'] : 100,
        current: typeof item['initialValue'] === 'number' ? item['initialValue']
          : typeof item['initial_value'] === 'number' ? item['initial_value'] : 0,
        initialValue: typeof item['initialValue'] === 'number' ? item['initialValue']
          : typeof item['initial_value'] === 'number' ? item['initial_value'] : 0,
        unit: String(item['unit'] ?? '%'),
        color: typeof item['color'] === 'string' ? item['color'] : undefined,
        showInMainPanel: item['showInMainPanel'] !== false,
        aiUpdatable: item['aiUpdatable'] !== false,
        maxDeltaPerRound: typeof item['maxDeltaPerRound'] === 'number'
          ? item['maxDeltaPerRound'] : DEFAULT_GAUGE_MAX_DELTA,
        autoDecrement: typeof item['autoDecrement'] === 'number' ? item['autoDecrement'] : undefined,
      }))
      .filter(g => g.name.trim());
  }
}
