import { cloneDeep } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import { eventBus } from '../../engine/core/event-bus';
import type { AIService } from '../../engine/ai/ai-service';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import type { PlotVectorRoundPort } from '../../engine/plot-vector/round-port';
import { randomId, readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements, readPath, savedEntryName } from './saved-elements';
import { tasksAfterSave, stable, capabilityKey, toRuntimeCandidate, type BoundCard, type GenesisOutput, type GenesisTask, type SavedElement } from './genesis/post-save';
import { buildAgaGenerationMessages, buildAbilityRetryMessages, parseAgaGenerationOutput, GENESIS_VALIDATION_REVISION, SNIPPET_API } from './genesis/generation-prompt';
import { initialVectorState, type AbilityRetry, type VectorState, type VectorTaskRow, type PreparedVector, type VectorOperation, type VectorResult } from './runtime';
import { abilityBacklog, type BacklogEntry } from './ability-backlog';
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
/** An environment tag whose ability is missing or failed validation (kept as a task row for later repair). */
interface EnvironmentIssue { entry: SavedElement; ability?: unknown; reason: string }
/**
 * Step3 retries an entry's ability in at most this many rounds (several tries inside one round count
 * once); after that only the player's explicit retry sends another request. One item/talent/status
 * entry is retried per round, the same pace as post-save generation.
 */
const AUTO_REPAIR_ROUNDS = 2;
const autoRoundsLeft = (row: VectorTaskRow, round: number) =>
  (row.retry?.autoRounds ?? 0) < AUTO_REPAIR_ROUNDS || row.retry?.lastAutoRound === round;
/** The previous ability card of a row (latest retry first), for the repair request's context. */
function previousAbility(row: VectorTaskRow): unknown {
  for (const raw of [row.retry?.raw, row.raw]) {
    if (raw === undefined) continue;
    try { return (JSON.parse(raw) as { card?: unknown }).card ?? null; } catch { return raw.slice(0, 2000); }
  }
  return null;
}
/** The card a Step3 reply gives for one entry: `[{ id, card }]` in the task's own reply field. */
function replyCardFor(output: unknown, id: string): unknown {
  if (!Array.isArray(output)) return undefined;
  const hit = output.find(e => e && typeof e === 'object' && (e as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
  return hit?.card;
}
interface Attempt { ctx: PipelineContext; guard: () => void; controller: AbortController; before: SavedElement[];
  state: VectorState; prepared: PreparedVector; slot: Slot; release: () => void; postSaved?: boolean;
}

/** Composition-root adapter. Models see saved capabilities; only the Worker sees executable cards. */
export class AgaPlotVectorAdapter implements PlotVectorRoundPort {
  private attempt?: Attempt;
  private revision = 0;
  /** Entries with a player retry in flight in this page; Step3 and a second click never overlap it. */
  private readonly manualInFlight = new Set<string>();
  private unsubs: Array<() => void>;
  /** Every Worker result crosses the shared host boundary (result-guard.ts) before it is used. */
  private readonly worker: Executor;
  constructor(private state: StateManager, private ai: Pick<AIService, 'generate'>,
    private saves: Pick<SaveManager, 'saveGame' | 'assertCurrent'>, private slot: () => Slot | null,
    worker: Executor = new VectorWorkerClient(), private journal = new RequestJournal(), private nativeRules?: NativeRules,
    private promptPolicy?: Pick<VectorPromptPolicy, 'mode' | 'transform' | 'separateTransform' | 'environmentAbility' | 'abilityRepair'>) {
    this.worker = guardedExecutor(worker);
    this.unsubs = [subscribePlotVectorControl(() => this.cancel()),
      eventBus.on<{type: string}>('engine:state-changed', e => {
        if (e.type === 'load' || e.type === 'rollback') {
          if (this.attempt) {
            this.attempt.ctx.meta.plotVectorLifecycle!.invalidated = true;
          }
          this.revision++; this.cancel();
        }
      }),
      eventBus.on('engine:rollback-complete', () => this.branchAfterRollback())];
  }
  /**
   * Only the player's explicit rollback starts a new branch; an automatic restore after a failed round does
   * not emit this event, so retrying that round still recovers the replies it already paid for.
   */
  private branchAfterRollback(): void {
    if (!readPlotVectorControl().enabled || !this.slot()) return;
    const state = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
    state.branch = randomId();
    this.state.set(P.plotVector, state);
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
          ...(ctx.meta.plotVectorRequestAttempt ? { attempt: ctx.meta.plotVectorRequestAttempt } : {}),
          ...(state.branch ? { branch: state.branch } : {}) },
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
    if (a.state.branch === undefined) delete next.branch; else next.branch = a.state.branch; // host-owned
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
      await this.recoverRetries(a);
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
  /**
   * Free, after the round is saved: a player retry whose reply was recorded but never reached the save
   * (page closed) is adopted from the local ledger, and any recorded retry reply not yet checked under the
   * current validation is checked. Nothing is sent from here.
   */
  private async recoverRetries(a: Attempt): Promise<void> {
    let changed = false;
    for (const row of a.state.tasks) {
      const retry = row.retry;
      if (!retry) continue;
      if (retry.sending && retry.raw === undefined) {
        const receipt = await this.journal.genesis(a.slot, `${row.task.key}#retry-${retry.attempts}`).lookup();
        a.guard();
        if (receipt.kind === 'raw') { retry.raw = receipt.raw; retry.sending = false; delete retry.validationRevision; changed = true; }
      }
      if (retry.raw !== undefined && (retry.validationRevision ?? 0) < GENESIS_VALIDATION_REVISION && row.status !== 'bound') {
        await this.validateReceived(a.state, row, a.guard);
        changed = true;
      }
    }
    if (changed) await this.persist(a);
  }
  /** Bind this round's environment abilities after the round is saved; they take part from the next round. */
  private async syncEnvironment(a: Attempt): Promise<void> {
    const policy = this.promptPolicy?.environmentAbility;
    if (!policy) return;
    // What each tag looked like when the round started (ability field excluded: it is only transport).
    const before = new Map(a.before.filter(e => e.kind === 'environment').map(e => {
      const { [policy.field]: _ability, ...capability } = e.capability;
      return [e.id, capabilityKey({ ...e, capability })] as const;
    }));
    // A tag still waiting for its ability from an earlier round stays on record even though it did not change.
    const waiting = new Set(a.state.tasks.filter(t => t.task.entry.kind === 'environment' && t.status === 'failed').map(t => t.task.key));
    const synced = await this.environmentCards(a.state, policy.field, (id, key) => before.get(id) !== key || waiting.has(key), a.guard);
    if (!synced.changed && !synced.tags) return;
    a.state = synced.state;
    if (synced.tags) this.state.set(P.environmentTags, synced.tags);
    await this.persist(a);
  }
  /**
   * One pass over the saved environment tags. A tag carrying a new ability gets a validated card that
   * replaces its old one; an unchanged tag without one keeps its card; a vanished tag loses its card. The ability
   * field is then taken out of the tags so no snippet stays in the story state or later prompts.
   * `needsAbility(id, key)` says whether a tag without a new ability is new, changed or still waiting (saved
   * content key, ability excluded): such a tag loses any old card and is repaired; otherwise its card carries over.
   * Tags that still need an ability are kept as failed task rows (with their retry history) so a later Step3
   * or the player can fill them after a reload; `attempt` marks the rows a Step3 request just tried.
   */
  private async environmentCards(state: VectorState, field: string, needsAbility: (id: string, key: string) => boolean, guard: () => void,
    attempt?: { round: number; ids: ReadonlySet<string> }):
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
        // A new or updated tag without its new ability must not keep running the old one: Step3 fills it.
        // Only a tag whose saved content is unchanged keeps its card.
        if (needsAbility(entry.id, task.key)) issues.push({ entry: bare, reason: existing ? '内容已更新但缺少新能力' : '缺少能力' });
        else if (existing) cards.push({ ...existing, task });
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
    // Environment rows are exactly the tags that still need an ability. Old post-save environment tasks and
    // rows of tags that are gone, changed or now have a card are dropped.
    const previousRows = new Map(state.tasks.filter(t => t.task.entry.kind === 'environment').map(t => [t.task.key, t]));
    const environmentRows = issues.map((issue): VectorTaskRow => {
      const task: GenesisTask = { key: capabilityKey(issue.entry), actionId: 'environment', entry: issue.entry };
      const prior = previousRows.get(task.key);
      const ability = issue.ability === undefined ? undefined : JSON.stringify({ version: 3, card: issue.ability });
      let retry = prior?.retry;
      if (attempt?.ids.has(issue.entry.id)) {
        // The attempt was counted when its Step3 request left; here only its reply is recorded.
        retry = { ...(retry ?? { attempts: 1, autoRounds: 1, lastAutoRound: attempt.round }), source: 'step3', error: issue.reason };
        // `raw` always describes this attempt: a reply without a new ability leaves none.
        delete retry.raw; delete retry.validationRevision;
        if (ability) { retry.raw = ability; retry.validationRevision = GENESIS_VALIDATION_REVISION; }
      }
      // The first failure keeps its own reason and ability; later attempts are recorded under `retry`.
      const raw = prior ? prior.raw : ability;
      return { task, status: 'failed', error: prior?.error ?? issue.reason,
        ...(raw !== undefined ? { raw, validationRevision: prior?.validationRevision ?? GENESIS_VALIDATION_REVISION } : {}),
        ...(retry ? { retry } : {}) };
    });
    const tasks = [...state.tasks.filter(t => t.task.entry.kind !== 'environment'), ...environmentRows];
    const next = { ...state, cards, tasks };
    const hasField = Array.isArray(rawTags) && rawTags.some(t => t && typeof t === 'object' && Object.hasOwn(t, field));
    const tags = hasField ? (rawTags as unknown[]).map(t => {
      if (!t || typeof t !== 'object' || !Object.hasOwn(t, field)) return t;
      const { [field]: _ability, ...rest } = t as Record<string, unknown>;
      return rest;
    }) : undefined;
    return { state: next, changed: stable(next) !== stable(state), issues, tags };
  }
  /** Obtained entries whose ability is not usable yet (the saved entries themselves are never touched). */
  abilityBacklog(): BacklogEntry[] {
    const state = this.state.get<VectorState>(P.plotVector);
    if (!state) return [];
    return abilityBacklog(state, projectSavedElements(this.state.toSnapshot(), { includeEnvironment: true }).entries,
      this.promptPolicy?.environmentAbility?.field);
  }
  /** Stops a repair whose save, feature epoch or loaded state changed underneath it. */
  private repairGuard(label: string): () => void {
    const slot = stable(this.slot()), revision = this.revision, epoch = readPlotVectorControl().epoch;
    return () => {
      const live = readPlotVectorControl();
      if (stable(this.slot()) !== slot || this.revision !== revision || !live.enabled || live.epoch !== epoch)
        throw new Error(`存档或剧情动能开关已改变，${label}已取消`);
    };
  }
  /**
   * Step3 hook: saved entries whose ability is missing or failed, as one task inside the existing
   * field-repair request. Environment tags are fixed as ordinary commands on the environment array (as
   * before); one item/talent/status entry per round comes back in the task's own reply field, never as a
   * write to the saved entry. `settle` binds what now validates and reports whether every listed entry has
   * an ability. Entries with an unknown outcome or a player retry in flight are never included; each entry
   * is tried automatically in at most AUTO_REPAIR_ROUNDS rounds.
   */
  async abilityRepairTask(): Promise<ExtraRepairTask | null> {
    const environment = this.promptPolicy?.environmentAbility, items = this.promptPolicy?.abilityRepair;
    if (!this.slot() || !readPlotVectorControl().enabled || (!environment && !items)) return null;
    const state = this.state.get<VectorState>(P.plotVector);
    if (!state) return null;
    const round = this.state.get<number>(P.roundNumber) ?? 0;
    const due = this.abilityBacklog().filter(b => b.state === 'failed' && !this.manualInFlight.has(b.id) && autoRoundsLeft(b.row, round));
    const tags = environment ? due.filter(b => b.kind === 'environment') : [];
    // Fresh failures first: an entry that has not been retried yet goes ahead of one already tried.
    const item = items ? due.filter(b => b.kind !== 'environment')
      .sort((x, y) => (x.row.retry?.autoRounds ?? 0) - (y.row.retry?.autoRounds ?? 0))[0] : undefined;
    if (!tags.length && !item) return null;
    const guard = this.repairGuard('能力补生');
    // Each task keeps its own instructions and output contract; the shared snippet contract is sent once.
    const blocks: string[] = [];
    if (environment && tags.length) {
      const list = tags.map(b => ({ name: b.name, ability: previousAbility(b.row), problem: b.problem ?? '缺少能力' }));
      blocks.push(`${environment.repair.split('{{PATH}}').join(P.environmentTags).split('{{ITEMS}}').join(JSON.stringify(list, null, 2))}\n\n${environment.instruction}`);
    }
    if (items && item) {
      const description = item.row.task.entry.capability.description;
      const list = [{ id: item.id, kind: item.kind, name: item.name, description: typeof description === 'string' ? description : '',
        problem: item.problem ?? '', ability: previousAbility(item.row) }];
      blocks.push(`${items.template.split('{{ITEMS}}').join(JSON.stringify(list, null, 2))}\n\n${items.guidance}`);
    }
    blocks.push(SNIPPET_API);
    const listed = [...tags, ...(item ? [item] : [])].map(b => capabilityKey(b.row.task.entry));
    return {
      block: blocks.join('\n\n'),
      // The request carrying this task is leaving: it is an attempt for every listed entry. Counted now, so a
      // request that fails without a reply still uses up the automatic rounds (`settle` records a reply).
      sent: () => {
        guard();
        const started = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
        let changed = false;
        for (const key of listed) {
          const row = started.tasks.find(t => capabilityKey(t.task.entry) === key && t.status !== 'bound');
          if (!row) continue;
          changed = true;
          const base: AbilityRetry = row.retry ?? { attempts: 0, autoRounds: 0 };
          const retry: AbilityRetry = { ...base, attempts: base.attempts + 1, source: 'step3', sending: false, error: '补生请求没有得到回复',
            ...(base.lastAutoRound === round ? {} : { autoRounds: base.autoRounds + 1, lastAutoRound: round }) };
          delete retry.raw; delete retry.validationRevision;
          row.retry = retry;
        }
        if (changed) this.state.set(P.plotVector, started);
      },
      ...(items && item ? { field: items.field } : {}),
      // Environment tags are fixed as commands on the tag array; item abilities never are.
      ...(tags.length ? {} : { commands: false }),
      settle: async (output?: unknown) => {
        guard();
        let next = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
        let resolved = true;
        if (environment && tags.length) {
          const ids = new Set(tags.map(b => b.id));
          // Tags waiting outside this batch (automatic rounds used up, player retry in flight) keep their rows.
          const waiting = new Set(next.tasks.filter(t => t.task.entry.kind === 'environment' && t.status === 'failed').map(t => t.task.key));
          const synced = await this.environmentCards(next, environment.field, (id, key) => ids.has(id) || waiting.has(key), guard, { round, ids });
          guard();
          next = synced.state;
          if (synced.tags) this.state.set(P.environmentTags, synced.tags);
          if (synced.issues.some(i => ids.has(i.entry.id))) resolved = false;
        }
        if (item) {
          const key = capabilityKey(item.row.task.entry);
          const row = next.tasks.find(t => capabilityKey(t.task.entry) === key && t.status !== 'bound');
          if (!row || !(await this.recordRetryReply(next, row, replyCardFor(output, item.id), guard))) resolved = false;
        }
        this.state.set(P.plotVector, next);
        return resolved;
      },
    };
  }
  /**
   * The player's "regenerate ability" for one obtained entry. A reply that was already received is checked
   * first, for free (under the current validation, or adopted from the local ledger if it never reached the
   * save). Only then is a new request sent, as a new recorded attempt with its own receipt: earlier failures
   * and unknown receipts stay as they were. Returns whether the entry now has a usable ability and whether a
   * model request was made. The saved entry itself is never changed.
   */
  async regenerateAbility(entryId: string): Promise<{ bound: boolean; requested: boolean }> {
    const slot = this.slot();
    if (!slot || !readPlotVectorControl().enabled) throw new Error('剧情动能未开启');
    if (this.manualInFlight.has(entryId)) throw new Error('这一条的能力正在补生');
    const guard = this.repairGuard('能力补生');
    this.manualInFlight.add(entryId);
    try {
      await this.saves.assertCurrent(slot.profileId, slot.slotId);
      guard();
      const state = cloneDeep(this.state.get<VectorState>(P.plotVector) ?? initialVectorState());
      const entry = abilityBacklog(state, projectSavedElements(this.state.toSnapshot(), { includeEnvironment: true }).entries,
        this.promptPolicy?.environmentAbility?.field).find(b => b.id === entryId);
      if (!entry) throw new Error('这一条目前没有需要补生的能力');
      const key = capabilityKey(entry.row.task.entry);
      const row = state.tasks.find(t => capabilityKey(t.task.entry) === key && t.status !== 'bound')!;
      // 1. Free: a reply recorded in the local ledger that never reached this save (first attempt without a reply,
      // whether it was left as sending or recorded as a failed request).
      if (!row.retry && row.raw === undefined && row.task.entry.kind !== 'environment') {
        const receipt = await this.journal.genesis(slot, row.task.key).lookup();
        guard();
        if (receipt.kind === 'raw') { row.raw = receipt.raw; delete row.validationRevision; }
      }
      if (row.retry?.sending && row.retry.raw === undefined) {
        const receipt = await this.journal.genesis(slot, `${row.task.key}#retry-${row.retry.attempts}`).lookup();
        guard();
        if (receipt.kind === 'raw') { row.retry.raw = receipt.raw; delete row.retry.validationRevision; }
        // Not in flight in this page (manualInFlight is empty for it), so its reply can no longer reach this save.
        // Its receipt stays as it is; this explicit click becomes a new attempt below instead of a permanent block
        // (charter D8). Nothing retries it automatically: Step3 never touches `retrying` entries.
        row.retry.sending = false;
      }
      // 2. Free: any received reply not yet checked under the current validation.
      if (await this.validateReceived(state, row, guard)) {
        await this.persistState(slot, state, guard);
        return { bound: true, requested: false };
      }
      // 3. A new request, recorded before it is sent.
      const problem = row.retry?.error ?? row.error;
      const base: AbilityRetry = row.retry ?? { attempts: 0, autoRounds: 0 };
      const retry: AbilityRetry = { ...base, attempts: base.attempts + 1, source: 'manual', sending: true };
      delete retry.raw; delete retry.validationRevision;
      row.retry = retry;
      await this.persistState(slot, state, guard);
      let raw: string;
      try {
        raw = await this.ai.generate({ messages: buildAbilityRetryMessages(row.task.entry, problem),
          usageType: 'main', stream: false, singleAttempt: true, generationId: `ability-retry:${retry.attempts}`,
          checkpoint: this.journal.genesis(slot, `${row.task.key}#retry-${retry.attempts}`).checkpoint(guard) });
      } catch (error) {
        guard();
        retry.sending = false; retry.error = error instanceof Error ? error.message : String(error);
        await this.persistState(slot, state, guard);
        return { bound: false, requested: true };
      }
      guard();
      retry.sending = false; retry.raw = raw;
      const bound = await this.validateReceived(state, row, guard);
      await this.persistState(slot, state, guard);
      return { bound, requested: true };
    } finally { this.manualInFlight.delete(entryId); }
  }
  /**
   * Record the reply of a Step3 attempt (already counted when its request left) and bind the ability if it
   * validates. `card` undefined: the reply had no ability for this entry.
   */
  private async recordRetryReply(state: VectorState, row: VectorTaskRow, card: unknown, guard: () => void): Promise<boolean> {
    const retry: AbilityRetry = { ...(row.retry ?? { attempts: 1, autoRounds: 1 }), source: 'step3', sending: false };
    delete retry.raw; delete retry.validationRevision;
    row.retry = retry;
    if (card === undefined) { retry.error = '补生回复没有给出这一条的能力'; return false; }
    retry.raw = JSON.stringify({ version: 3, card });
    return this.validateReceived(state, row, guard);
  }
  /**
   * Check the received replies of a row that have not been checked under the current validation (the latest
   * retry first, then the first attempt) and bind the first that validates. A failure is recorded on the
   * reply it belongs to; nothing is sent.
   */
  private async validateReceived(state: VectorState, row: VectorTaskRow, guard: () => void): Promise<boolean> {
    // `clear` runs on success: a retry's success leaves the first attempt's failure on record.
    const replies: Array<{ raw: string; mark(): void; fail(reason: string): void; clear(): void }> = [];
    const retry = row.retry;
    if (retry?.raw !== undefined && (retry.validationRevision ?? 0) < GENESIS_VALIDATION_REVISION) {
      const raw = retry.raw;
      replies.push({ raw, mark: () => { retry.validationRevision = GENESIS_VALIDATION_REVISION; },
        fail: reason => { retry.error = reason; }, clear: () => { delete retry.error; } });
    }
    if (row.raw !== undefined && (row.validationRevision ?? 0) < GENESIS_VALIDATION_REVISION) {
      const raw = row.raw;
      replies.push({ raw, mark: () => { row.validationRevision = GENESIS_VALIDATION_REVISION; },
        fail: reason => { row.error = reason; }, clear: () => { delete row.error; } });
    }
    for (const reply of replies) {
      reply.mark();
      try {
        const bound = await this.worker.execute<BoundCard>({ kind: 'validate', task: row.task, output: parseAgaGenerationOutput(reply.raw), attempts: 1 });
        guard();
        state.cards = [...state.cards.filter(c => c.task.entry.id !== row.task.entry.id), bound];
        row.status = 'bound';
        reply.clear();
        return true;
      } catch (error) {
        guard();
        row.status = row.status === 'pending' ? row.status : 'failed';
        reply.fail(error instanceof Error ? error.message : String(error));
      }
    }
    return false;
  }
  /** Save the vector state outside a round (player retry). A failed write never leaves the new state in memory. */
  private async persistState(slot: Slot, state: VectorState, guard: () => void): Promise<void> {
    guard();
    const previous = cloneDeep(this.state.get<VectorState>(P.plotVector));
    this.state.set(P.plotVector, cloneDeep(state));
    let committed = false;
    try {
      await this.saves.saveGame(slot.profileId, slot.slotId, this.state.toSnapshot(), undefined, { guard, committed: () => { committed = true; } });
    } catch (error) {
      if (!committed) this.state.set(P.plotVector, previous);
      throw error;
    }
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
