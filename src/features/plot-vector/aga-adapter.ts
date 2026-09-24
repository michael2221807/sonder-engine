import { cloneDeep } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import { eventBus } from '../../engine/core/event-bus';
import type { AIService } from '../../engine/ai/ai-service';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import type { PlotVectorRoundPort } from '../../engine/plot-vector/round-port';
import { readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements, readPath, savedEntryName } from './saved-elements';
import { tasksAfterSave, stable, capabilityKey, toRuntimeCandidate, type BoundCard, type GenesisOutput, type GenesisTask, type SavedElement } from './genesis/post-save';
import { buildAgaGenerationMessages, parseAgaGenerationOutput, GENESIS_VALIDATION_REVISION } from './genesis/generation-prompt';
import { initialVectorState, type VectorState, type PreparedVector, type VectorOperation, type VectorResult } from './runtime';
import { VectorWorkerClient } from './worker-client';
import { guardedExecutor } from './result-guard';
import { RequestJournal } from './request-journal';
import { projectNativeInput, type NativeRules } from './native-input';
import type { VectorPromptPolicy } from './prompt-policy';
import type { ExtraRepairTask } from '../../engine/pipeline/sub-pipelines/field-repair';
import { resolveInventoryCommands } from './inventory-commands';
import { compiledCommandGuard } from './command-guard';

type Slot = { profileId: string; slotId: string };
interface Executor { execute<T extends VectorResult>(op: VectorOperation): Promise<T>; cancelAll(): void }
/** An environment tag whose ability is missing or failed validation this round (Step3 repair input). */
interface EnvironmentIssue { entry: SavedElement; ability?: unknown; reason: string }
interface Attempt { ctx: PipelineContext; guard: () => void; controller: AbortController; before: SavedElement[];
  state: VectorState; prepared: PreparedVector; slot: Slot; release: () => void; postSaved?: boolean;
}

/** Composition-root adapter. Models see saved capabilities; only the Worker sees executable cards. */
export class AgaPlotVectorAdapter implements PlotVectorRoundPort {
  private attempt?: Attempt;
  private revision = 0;
  /** This round's environment tags that still need an ability; consumed by the Step3 repair task. */
  private environmentIssues?: { slot: string; revision: number; epoch: string; issues: EnvironmentIssue[] };
  private unsubs: Array<() => void>;
  /** Every Worker result crosses the shared host boundary (result-guard.ts) before it is used. */
  private readonly worker: Executor;
  constructor(private state: StateManager, private ai: Pick<AIService, 'generate'>,
    private saves: Pick<SaveManager, 'saveGame' | 'assertCurrent'>, private slot: () => Slot | null,
    worker: Executor = new VectorWorkerClient(), private journal = new RequestJournal(), private nativeRules?: NativeRules,
    private promptPolicy?: Pick<VectorPromptPolicy, 'mode' | 'transform' | 'separateTransform' | 'environmentAbility'>) {
    this.worker = guardedExecutor(worker);
    this.unsubs = [subscribePlotVectorControl(() => this.cancel()),
      eventBus.on<{type: string}>('engine:state-changed', e => {
        if (e.type === 'load' || e.type === 'rollback') {
          if (this.attempt) {
            this.attempt.ctx.meta.plotVectorLifecycle!.invalidated = true;
          }
          this.revision++; this.cancel();
        }
      })];
  }
  private cancel() { this.attempt?.controller.abort(); this.worker.cancelAll(); }
  dispose() { this.cancel(); this.attempt?.release(); this.unsubs.forEach(fn => fn()); }
  promptTransform(ctx: PipelineContext) {
    if (ctx.meta.isEnhancedOpening) return;
    const control = readPlotVectorControl();
    ctx.meta.plotVectorAssemblyEpoch = control.epoch;
    const slot = this.slot();
    if (!control.enabled || !slot) return;
    if (!this.promptPolicy) throw new Error('当前游戏包尚未配置剧情动能提示，关闭剧情动能可继续原流程');
    const revision = this.revision;
    ctx.meta.plotVectorLifecycle ??= {};
    ctx.meta.plotVectorGuard = () => {
      if (revision !== this.revision || stable(this.slot()) !== stable(slot)) {
        ctx.meta.plotVectorLifecycle!.invalidated = true;
        throw new Error('存档已切换，旧回合已取消');
      }
      if (readPlotVectorControl().epoch !== control.epoch || ctx.abortSignal?.aborted)
        throw new Error('剧情动能开关在组装期间改变，请重新开始本回合');
    };
    ctx.meta.plotVectorPromptMode = true;
    const separate = control.settlement === 'separate' && ctx.meta.splitGen === true;
    ctx.meta.stateUpdateSource = separate ? 'settlement' : 'inline';
    return separate ? this.promptPolicy.separateTransform : this.promptPolicy.transform;
  }
  async prepare(ctx: PipelineContext): Promise<PipelineContext> {
    ctx.meta.plotVectorGuard?.();
    this.attempt?.release(); this.attempt = undefined;
    const control = readPlotVectorControl(), slot = this.slot();
    if (ctx.meta.plotVectorAssemblyEpoch !== undefined && ctx.meta.plotVectorAssemblyEpoch !== control.epoch)
      throw new Error('剧情动能开关在组装期间改变，请重新开始本回合');
    if (!control.enabled || !slot || ctx.meta.isEnhancedOpening) return ctx;
    ctx.meta.plotVectorLifecycle ??= {};
    const revision = this.revision, controller = new AbortController();
    const abort = () => { controller.abort(); this.worker.cancelAll(); };
    ctx.abortSignal?.addEventListener('abort', abort, { once: true });
    const identityGuard = () => {
      const currentSlot = this.slot();
      if (revision !== this.revision || stable(currentSlot) !== stable(slot)) {
        ctx.meta.plotVectorLifecycle!.invalidated = true;
      }
      if (ctx.meta.plotVectorLifecycle!.invalidated) throw new Error('存档已切换，旧回合已取消');
    };
    const guard = () => {
      identityGuard();
      const live = readPlotVectorControl();
      if (controller.signal.aborted || ctx.abortSignal?.aborted || !live.enabled || live.epoch !== control.epoch)
        throw new Error('剧情动能已取消；未提交的回合不会扣次数');
    };
    ctx.meta.plotVectorGuard = () => ctx.meta.plotVectorLifecycle!.saved ? identityGuard() : guard();
    const state = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
    const before = projectSavedElements(ctx.stateSnapshot, { includeEnvironment: true }).entries;
    try {
      guard();
      await this.saves.assertCurrent(slot.profileId, slot.slotId);
      guard();
      const prepared = await this.worker.execute<PreparedVector>({ kind: 'prepare', state, entries: before,
        native: projectNativeInput(ctx.stateSnapshot, this.nativeRules),
        id: `${slot.profileId}/${slot.slotId}/${ctx.roundNumber}` });
      guard();
      this.attempt = { ctx, controller, guard, state, before, prepared, slot,
        release: () => ctx.abortSignal?.removeEventListener('abort', abort) };
      const recovered: string[] = [];
      ctx.meta.plotVectorRecovered = recovered;
      ctx.meta.plotVectorCheckpoint = step => this.journal.checkpoint(
        { slot, epoch: control.epoch, round: ctx.roundNumber, input: ctx.originalUserInput ?? ctx.userInput, step,
          ...(ctx.meta.plotVectorRequestAttempt ? { attempt: ctx.meta.plotVectorRequestAttempt } : {}) },
        ctx.preRoundSnapshot ?? ctx.stateSnapshot, guard,
        () => { if (!recovered.includes(step)) recovered.push(step); });
      ctx.meta.plotVectorCommitted = () => {
        ctx.meta.plotVectorLifecycle!.saved = true;
        // Committed story is never rolled back by a late cancellation/metadata failure.
      };
      const mode = ctx.meta.plotVectorPromptMode ? this.promptPolicy?.mode : undefined;
      const additions: import('../../engine/ai/types').AIMessage[] = [];
      const sources: string[] = [];
      if (mode) { additions.push({ role: 'system', content: mode }); sources.push('plot-vector-mode'); }
      if (prepared.prompt) { additions.push({ role: 'system', content: prepared.prompt }); sources.push('plot-vector'); }
      // Environment tags are written by Step2 (or the single call), so their ability interface goes there,
      // the same way the state-update protocol does; Step1 never sees it.
      const environment = ctx.meta.plotVectorPromptMode ? this.promptPolicy?.environmentAbility?.prompt : undefined;
      if (environment && ctx.meta.splitStep2Messages) {
        const base = ctx.meta.splitStep2Messages;
        ctx.meta.splitStep2Messages = [{ role: 'system', content: environment }, ...base];
        ctx.meta.splitStep2Sources = ['environment-ability', ...(ctx.meta.splitStep2Sources ?? base.map(() => 'unknown'))];
      } else if (environment) { additions.push({ role: 'system', content: environment }); sources.push('environment-ability'); }
      if (!additions.length) return { ...ctx, abortSignal: controller.signal };
      // The builder can end with user + assistant prefill. Mid-conversation
      // system messages must precede that user turn, not split it from prefill.
      // With no user turn, keep the addition in the leading system context.
      let at = 0;
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        if (ctx.messages[i].role === 'user') { at = i; break; }
      }
      return { ...ctx, abortSignal: controller.signal, messages: [...ctx.messages.slice(0, at), ...additions, ...ctx.messages.slice(at)],
        messageSources: [...(ctx.messageSources ?? ctx.messages.map(() => 'unknown')).slice(0, at), ...sources,
          ...(ctx.messageSources ?? ctx.messages.map(() => 'unknown')).slice(at)] };
    } catch (error) { ctx.abortSignal?.removeEventListener('abort', abort); throw error; }
  }
  beforeCommands(ctx: PipelineContext): PipelineContext {
    const a = this.attempt;
    if (!a || a.ctx.generationId !== ctx.generationId) return ctx;
    a.guard();
    if (a.ctx.meta.plotVectorLifecycle?.saved) throw new Error('本回合已经提交，不能再次执行状态更新');
    this.assertStructure(ctx);
    // Host synchronization already owns these commands and their execution guard.
    if (ctx.meta.stateUpdatesRequired) return ctx;
    if (!ctx.parsedResponse?.commands) return ctx;
    const ids = a.before.filter(e => e.kind === 'item').map(e => e.id.slice('item:'.length));
    const resolved = resolveInventoryCommands(ctx.parsedResponse.commands, ids, ctx.roundNumber);
    return { ...ctx, parsedResponse: { ...ctx.parsedResponse, commands: resolved.commands },
      rejectedCommands: [...(ctx.rejectedCommands ?? []), ...resolved.rejected.map(r => ({
        success: false, command: ctx.parsedResponse!.commands![r.index], error: r.reason,
      }))],
      meta: { ...ctx.meta, plotVectorInventoryRejected: resolved.rejected,
        stateUpdateCommandGuard: compiledCommandGuard([P.inventoryItems], resolved.commands.filter(c => c.key.startsWith(P.inventoryItems + '.'))) } };
  }
  async beforeSave(ctx: PipelineContext): Promise<void> {
    const a = this.attempt;
    if (!a || a.ctx.generationId !== ctx.generationId) return;
    a.guard();
    this.assertStructure(ctx);
    const next = a.state.last?.id === a.prepared.id ? a.state : await this.worker.execute<VectorState>({ kind: 'accept', state: a.state, prepared: a.prepared });
    a.guard();
    const after = projectSavedElements(this.state.toSnapshot(), { includeEnvironment: true }).entries;
    // Environment abilities arrive with the tags from Step2; they never queue a post-save generation.
    const tasks = tasksAfterSave({ id: a.prepared.id, success: true, before: a.before, after }, next.tasks.map(t => t.task.key))
      .filter(task => task.entry.kind !== 'environment');
    next.tasks.push(...tasks.map(task => ({ task, status: 'pending' as const })));
    a.state = next;
    this.state.set(P.plotVector, next);
  }
  async afterSave(ctx: PipelineContext): Promise<void> {
    const a = this.attempt;
    if (!a || a.ctx.generationId !== ctx.generationId || !ctx.meta.plotVectorLifecycle?.saved || a.postSaved) return;
    a.postSaved = true;
    try {
      a.guard();
      await this.recoverReceipts(a);
      await this.syncEnvironment(a);
      const current = projectSavedElements(this.state.toSnapshot(), { includeEnvironment: true }).entries;
      // One new ability per round. Removed/replaced entries never cause paid generation.
      const row = a.state.tasks.find(t => t.task.entry.kind !== 'environment' && (t.status === 'pending' || (t.status === 'sending' && t.raw !== undefined)
        || (t.status === 'failed' && t.raw !== undefined && (t.validationRevision ?? 0) < GENESIS_VALIDATION_REVISION))
        && current.some(e => capabilityKey(e) === capabilityKey(t.task.entry))
        && !a.state.cards.some(c => capabilityKey(c.task.entry) === capabilityKey(t.task.entry)));
      if (!row) return;
      if (row.raw === undefined) {
        row.status = 'sending';
        await this.persist(a);
        a.guard();
        let raw: string;
        try {
          raw = await this.ai.generate({ messages: buildAgaGenerationMessages(row.task.entry),
            usageType: 'main', stream: false, singleAttempt: true, generationId: `${ctx.generationId}:card`, signal: a.controller.signal,
            checkpoint: this.journal.genesis(a.slot, row.task.key).checkpoint(a.guard) });
        } catch (error) {
          a.guard();
          row.status = 'failed'; row.error = String(error);
          // The story is already committed. Record failure, never claim a request
          // is still sending and never automatically repeat an uncertain paid call.
          await this.persist(a); return;
        }
        a.guard();
        // Keep the paid output before validation. Reload never automatically repeats a sending task.
        row.raw = raw;
        await this.persist(a);
      }
      try {
        row.validationRevision = GENESIS_VALIDATION_REVISION;
        const bound = await this.worker.execute<BoundCard>({ kind: 'validate', task: row.task, output: parseAgaGenerationOutput(row.raw), attempts: 1 });
        a.guard();
        a.state.cards = [...a.state.cards.filter(c => c.task.entry.id !== bound.task.entry.id), bound];
        row.status = 'bound';
        delete row.error;
      } catch (error) {
        a.guard(); row.status = 'failed'; row.error = String(error);
      }
      await this.persist(a);
    } finally { a.release(); }
  }
  /**
   * Free recovery of ability replies that were received but never reached this save (page closed,
   * slot switched, save write failed). Rows without a reply are looked up read-only in the local
   * ledger: a recorded reply is adopted and validated later in this round like any other; anything
   * else (`unknown`, `none`, `expired`) is left exactly as it is. Nothing is sent from here, and no
   * row is marked failed, because another tab may still be waiting for that request.
   */
  private async recoverReceipts(a: Attempt): Promise<void> {
    let adopted = false;
    for (const row of a.state.tasks) {
      if ((row.status !== 'sending' && row.status !== 'failed') || row.raw !== undefined || row.task.entry.kind === 'environment') continue;
      const receipt = await this.journal.genesis(a.slot, row.task.key).lookup();
      a.guard();
      if (receipt.kind !== 'raw') continue;
      row.raw = receipt.raw; row.status = 'sending'; delete row.error; delete row.validationRevision;
      adopted = true;
    }
    if (adopted) await this.persist(a);
  }
  /** Bind this round's environment abilities after the round is saved; they take part from the next round. */
  private async syncEnvironment(a: Attempt): Promise<void> {
    const policy = this.promptPolicy?.environmentAbility;
    if (!policy) return;
    const beforeIds = new Set(a.before.filter(e => e.kind === 'environment').map(e => e.id));
    const synced = await this.environmentCards(a.state, policy.field, id => !beforeIds.has(id), a.guard);
    this.environmentIssues = synced.issues.length
      ? { slot: stable(a.slot), revision: this.revision, epoch: readPlotVectorControl().epoch, issues: synced.issues } : undefined;
    if (!synced.changed && !synced.tags) return;
    a.state = synced.state;
    if (synced.tags) this.state.set(P.environmentTags, synced.tags);
    await this.persist(a);
  }
  /**
   * One pass over the saved environment tags. A tag carrying a new ability gets a validated card that
   * replaces its old one; a tag without one keeps its card; a vanished tag loses its card. The ability
   * field is then taken out of the tags so no snippet stays in the story state or later prompts.
   * `needsAbility(id)` decides whether a tag without any card should be repaired.
   */
  private async environmentCards(state: VectorState, field: string, needsAbility: (id: string) => boolean, guard: () => void):
    Promise<{ state: VectorState; changed: boolean; issues: EnvironmentIssue[]; tags?: unknown[] }> {
    const snapshot = this.state.toSnapshot();
    const rawTags = readPath(snapshot, P.environmentTags);
    const entries = projectSavedElements(snapshot, { includeEnvironment: true }).entries.filter(e => e.kind === 'environment');
    const previous = new Map(state.cards.filter(c => c.task.entry.kind === 'environment').map(c => [c.task.entry.id, c]));
    const cards = state.cards.filter(c => c.task.entry.kind !== 'environment');
    const issues: EnvironmentIssue[] = [];
    for (const entry of entries) {
      const { [field]: ability, ...capability } = entry.capability;
      const bare: SavedElement = { ...entry, capability };
      const task: GenesisTask = { key: capabilityKey(bare), actionId: 'environment', entry: bare };
      const existing = previous.get(entry.id);
      if (ability === undefined) {
        if (existing) cards.push({ ...existing, task });
        else if (needsAbility(entry.id)) issues.push({ entry: bare, reason: '缺少能力' });
        continue;
      }
      let output: GenesisOutput;
      try { output = parseAgaGenerationOutput(JSON.stringify({ version: 3, card: ability })); }
      catch (error) { issues.push({ entry: bare, ability, reason: error instanceof Error ? error.message : String(error) }); continue; }
      if (existing && stable(existing.candidate) === stable(toRuntimeCandidate(task, output))) { cards.push({ ...existing, task }); continue; }
      try {
        cards.push(await this.worker.execute<BoundCard>({ kind: 'validate', task, output, attempts: 1 }));
        guard();
      } catch (error) {
        guard();
        issues.push({ entry: bare, ability, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    // A tag that is still present but could not be projected (e.g. two tags share a name) keeps its card:
    // only a tag that is actually gone loses its ability here.
    const present = new Set((Array.isArray(rawTags) ? rawTags : []).map(savedEntryName).filter((n): n is string => !!n));
    const projected = new Set(entries.map(e => e.id));
    for (const [id, card] of previous) {
      if (!projected.has(id) && present.has(String(card.task.entry.capability.name))) cards.push(card);
    }
    // Old post-save environment tasks are inert now; drop them so they never read as unfinished work.
    const tasks = state.tasks.filter(t => t.task.entry.kind !== 'environment');
    const next = { ...state, cards, tasks };
    const hasField = Array.isArray(rawTags) && rawTags.some(t => t && typeof t === 'object' && Object.hasOwn(t, field));
    const tags = hasField ? (rawTags as unknown[]).map(t => {
      if (!t || typeof t !== 'object' || !Object.hasOwn(t, field)) return t;
      const { [field]: _ability, ...rest } = t as Record<string, unknown>;
      return rest;
    }) : undefined;
    return { state: next, changed: stable(next) !== stable(state), issues, tags };
  }
  /**
   * Step3 hook: this round's environment tags whose ability is missing or invalid, as one repair task
   * inside the existing field-repair request. The fix arrives as ordinary commands on the environment
   * array; `settle` binds what now validates and reports whether every listed tag has an ability.
   */
  async environmentRepairTask(): Promise<ExtraRepairTask | null> {
    const pending = this.environmentIssues, policy = this.promptPolicy?.environmentAbility, slot = this.slot();
    const control = readPlotVectorControl();
    if (!pending || !policy || !slot || !control.enabled || pending.slot !== stable(slot) || pending.revision !== this.revision
      || pending.epoch !== control.epoch) return null;
    const guard = () => {
      const live = readPlotVectorControl();
      if (stable(this.slot()) !== pending.slot || this.revision !== pending.revision || !live.enabled || live.epoch !== pending.epoch)
        throw new Error('存档或剧情动能开关已改变，环境能力修复已取消');
    };
    const items = pending.issues.map(issue => ({ name: issue.entry.capability.name, ability: issue.ability ?? null, problem: issue.reason }));
    const block = `${policy.repair.split('{{PATH}}').join(P.environmentTags).split('{{ITEMS}}').join(JSON.stringify(items, null, 2))}\n\n${policy.prompt}`;
    const ids = new Set(pending.issues.map(i => i.entry.id));
    return {
      block,
      settle: async () => {
        guard();
        const state = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
        const synced = await this.environmentCards(state, policy.field, id => ids.has(id), guard);
        guard();
        if (synced.changed) this.state.set(P.plotVector, synced.state);
        if (synced.tags) this.state.set(P.environmentTags, synced.tags);
        const remaining = synced.issues.filter(i => ids.has(i.entry.id));
        this.environmentIssues = remaining.length ? { ...pending, issues: remaining } : undefined;
        return remaining.length === 0;
      },
    };
  }
  private async persist(a: Attempt): Promise<void> {
    a.guard();
    const previous = cloneDeep(this.state.get<VectorState>(P.plotVector));
    this.state.set(P.plotVector, cloneDeep(a.state));
    let committed = false;
    try {
      await this.saves.saveGame(a.slot.profileId, a.slot.slotId, this.state.toSnapshot(), undefined,
        { guard: a.guard, committed: () => { committed = true; } });
    } catch (error) {
      if (!committed && !a.ctx.meta.plotVectorLifecycle?.invalidated) this.state.set(P.plotVector, previous);
      throw error;
    }
  }
  private assertStructure(ctx: PipelineContext): void {
    // Repair has already had its chance. A failed parse is not a valid
    // no-change turn: never accept growth or save a narrative-only success.
    if (ctx.parsedResponse?.parseOk === false) {
      throw new Error('本回合状态更新格式有误，未获得可保存的结果。' + (typeof ctx.meta.plotVectorRepairError === 'string' ? ctx.meta.plotVectorRepairError : ''));
    }
  }
}
