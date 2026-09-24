import { cloneDeep } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import { eventBus } from '../../engine/core/event-bus';
import type { AIService } from '../../engine/ai/ai-service';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import type { PlotVectorRoundPort } from '../../engine/plot-vector/round-port';
import { readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements } from './saved-elements';
import { tasksAfterSave, stable, capabilityKey, type BoundCard, type SavedElement } from './genesis/post-save';
import { buildAgaGenerationMessages, parseAgaGenerationOutput, GENESIS_VALIDATION_REVISION } from './genesis/generation-prompt';
import { initialVectorState, type VectorState, type PreparedVector, type VectorOperation, type VectorResult } from './runtime';
import { VectorWorkerClient } from './worker-client';
import { guardedExecutor } from './result-guard';
import { RequestJournal } from './request-journal';
import { projectNativeInput, type NativeRules } from './native-input';
import type { VectorPromptPolicy } from './prompt-policy';
import { resolveInventoryCommands } from './inventory-commands';
import { compiledCommandGuard } from './command-guard';

type Slot = { profileId: string; slotId: string };
interface Executor { execute<T extends VectorResult>(op: VectorOperation): Promise<T>; cancelAll(): void }
interface Attempt { ctx: PipelineContext; guard: () => void; controller: AbortController; before: SavedElement[];
  state: VectorState; prepared: PreparedVector; slot: Slot; release: () => void; postSaved?: boolean;
}

/** Composition-root adapter. Models see saved capabilities; only the Worker sees executable cards. */
export class AgaPlotVectorAdapter implements PlotVectorRoundPort {
  private attempt?: Attempt;
  private revision = 0;
  private unsubs: Array<() => void>;
  /** Every Worker result crosses the shared host boundary (result-guard.ts) before it is used. */
  private readonly worker: Executor;
  constructor(private state: StateManager, private ai: Pick<AIService, 'generate'>,
    private saves: Pick<SaveManager, 'saveGame' | 'assertCurrent'>, private slot: () => Slot | null,
    worker: Executor = new VectorWorkerClient(), private journal = new RequestJournal(), private nativeRules?: NativeRules,
    private promptPolicy?: Pick<VectorPromptPolicy, 'mode' | 'transform' | 'separateTransform'>) {
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
    const tasks = tasksAfterSave({ id: a.prepared.id, success: true, before: a.before, after }, next.tasks.map(t => t.task.key));
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
      const current = projectSavedElements(this.state.toSnapshot(), { includeEnvironment: true }).entries;
      // One new ability per round. Removed/replaced entries never cause paid generation.
      const row = a.state.tasks.find(t => (t.status === 'pending' || (t.status === 'sending' && t.raw !== undefined)
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
            usageType: 'main', stream: false, singleAttempt: true, generationId: `${ctx.generationId}:card`, signal: a.controller.signal });
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
