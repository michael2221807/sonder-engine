import { cloneDeep } from 'lodash-es';
import type { StateManager } from '../../engine/core/state-manager';
import { eventBus } from '../../engine/core/event-bus';
import type { AIService } from '../../engine/ai/ai-service';
import type { AIMessage } from '../../engine/ai/types';
import type { SaveManager } from '../../engine/persistence/save-manager';
import { DEFAULT_ENGINE_PATHS as P, type PipelineContext } from '../../engine/pipeline/types';
import type { PlotVectorRoundPort } from '../../engine/plot-vector/round-port';
import type { LocalizedLabel } from '../../engine/plot-vector/core/types';
import type { RoundOwnership } from '../../engine/core/round-ownership';
import { readPlotVectorControl, subscribePlotVectorControl } from '../../engine/plot-vector/feature-control';
import { projectSavedElements, readPath, savedEntryName, savedSources } from './saved-elements';
import { stable, capabilityKey, type BoundCard, type SavedElement } from './genesis/post-save';
import { buildAbilityRetryMessages, parseCardReply, CARD_API } from './genesis/generation-prompt';
import { acceptVector, bindCard, cardTypeOf, prepareVector, readVectorState, type AbilityRetry, type VectorState, type VectorTaskRow, type PreparedVector } from './runtime';
import { initialSupply, supplyHandInfo, supplyNames, type SupplyRules } from './supply';
import { roundOpening } from './table-model';
import { tierOf, type CardTier } from './rating';
import { abilityBacklog, type BacklogEntry } from './ability-backlog';
import { bindRoundAbilities, readAbilityBlock } from './round-abilities';
import { projectNativeInput, type NativeRules } from './native-input';
import type { VectorPromptPolicy } from './prompt-policy';
import type { ExtraRepairTask } from '../../engine/pipeline/sub-pipelines/field-repair';

type Slot = { profileId: string; slotId: string };
/**
 * Step3 retries an entry's ability in at most this many rounds (several tries inside one round count
 * once); after that only the player's explicit retry sends another request.
 */
const AUTO_REPAIR_ROUNDS = 2;
/** Step3 fills at most this many backlog entries per request; the rest wait for later rounds (agent-set, I25). */
export const REPAIR_BATCH = 8;
const autoRoundsLeft = (row: VectorTaskRow, round: number) =>
  (row.retry?.autoRounds ?? 0) < AUTO_REPAIR_ROUNDS || row.retry?.lastAutoRound === round;
/** The previous ability card of a row (latest retry first), for the repair request's context. */
function previousAbility(row: VectorTaskRow): unknown {
  for (const raw of [row.retry?.raw, row.raw]) {
    if (raw === undefined) continue;
    try { return parseCardReply(raw); } catch { return raw.slice(0, 2000); }
  }
  return null;
}
/** The card a Step3 reply gives for one entry: `[{ id, card }]` in the task's own reply field. */
function replyCardFor(output: unknown, id: string): unknown {
  if (!Array.isArray(output)) return undefined;
  const hit = output.find(e => e && typeof e === 'object' && (e as Record<string, unknown>).id === id) as Record<string, unknown> | undefined;
  return hit?.card;
}
/** The stored row of a backlog entry, created when the entry had none yet (an entry never tried, I20). */
function rowOf(state: VectorState, entry: BacklogEntry): VectorTaskRow {
  const key = capabilityKey(entry.row.task.entry);
  let row = state.tasks.find(t => capabilityKey(t.task.entry) === key);
  if (!row) { row = { task: entry.row.task }; state.tasks.push(row); }
  return row;
}
/** Insert messages right before the last user turn (or at the end when there is none), keeping the sources aligned. */
function beforeLastUser(messages: AIMessage[], sources: string[] | undefined, added: AIMessage[], addedSources: string[]) {
  let at = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { at = i; break; }
  const own = sources ?? messages.map(() => 'unknown');
  return { messages: [...messages.slice(0, at), ...added, ...messages.slice(at)], sources: [...own.slice(0, at), ...addedSources, ...own.slice(at)] };
}
/**
 * One round's momentum. `prepared` is absent when this round's trip could not be computed: the round then
 * runs without momentum, and nothing of the component advances except the round's new abilities.
 */
interface Attempt { ctx: PipelineContext; owner: RoundOwnership; guard: () => void; controller: AbortController;
  before: SavedElement[]; state: VectorState; id: string; prepared?: PreparedVector; slot: Slot; release: () => void;
  gained: BoundCard[];
  /** Supply cards drawn when this round was accepted (announced after it is saved), with their tier. */
  drawn: Array<{ name: LocalizedLabel; tier: CardTier }>;
}
/** The component failed on its own; the story goes on. Only a cancellation or slot switch stops the round. */
function degraded(i18nKey: string, message: string, error: unknown): void {
  console.warn(`[PlotVector] ${message}`, error);
  eventBus.emit('ui:toast', { type: 'warning', i18nKey, message, duration: 4000 });
}

/** Composition-root adapter. Models see saved capabilities; cards run in the page (rebuild plan §4). */
export class AgaPlotVectorAdapter implements PlotVectorRoundPort {
  private attempt?: Attempt;
  private revision = 0;
  /** Entries with a player retry in flight in this page; Step3 and a second click never overlap it. */
  private readonly manualInFlight = new Set<string>();
  private unsubs: Array<() => void>;
  constructor(private state: StateManager, private ai: Pick<AIService, 'generate'>,
    private saves: Pick<SaveManager, 'saveGame'>, private slot: () => Slot | null,
    private nativeRules?: NativeRules,
    private promptPolicy?: Pick<VectorPromptPolicy, 'mode' | 'transform' | 'abilityBlock' | 'abilityRepair'>,
    private supplyRules?: SupplyRules) {
    this.unsubs = [subscribePlotVectorControl(() => this.cancel()),
      // The round itself notices a load or rollback through its RoundOwnership; this stops work in flight.
      eventBus.on<{type: string}>('engine:state-changed', e => {
        if (e.type === 'load' || e.type === 'rollback') { this.revision++; this.cancel(); }
      })];
  }
  private cancel() { this.attempt?.controller.abort(); }
  dispose() { this.cancel(); this.attempt?.release(); this.unsubs.forEach(fn => fn()); }
  promptTransform(ctx: PipelineContext) {
    if (ctx.meta.isEnhancedOpening) return;
    const control = readPlotVectorControl();
    ctx.meta.plotVectorAssemblyEpoch = control.epoch;
    const owner = ctx.meta.roundOwnership;
    // The component only takes part in a round the host owns (same save, same load).
    if (!control.enabled || !this.slot() || !owner) return;
    if (!this.promptPolicy) throw new Error('当前游戏包尚未配置剧情动能提示，关闭剧情动能可继续原流程');
    ctx.meta.plotVectorGuard = () => {
      owner.guard();
      if (readPlotVectorControl().epoch !== control.epoch) throw new Error('剧情动能开关在组装期间改变，请重新开始本回合');
    };
    ctx.meta.plotVectorPromptMode = true;
    // Rounds in this mode write no system lines (PO 2026-10-02 A); the old ones in the save must not invite more.
    ctx.meta.historyStoryOnly = true;
    return this.promptPolicy.transform;
  }
  async prepare(ctx: PipelineContext): Promise<PipelineContext> {
    ctx.meta.plotVectorGuard?.();
    this.attempt?.release(); this.attempt = undefined;
    const control = readPlotVectorControl(), slot = this.slot();
    if (ctx.meta.plotVectorAssemblyEpoch !== undefined && ctx.meta.plotVectorAssemblyEpoch !== control.epoch)
      throw new Error('剧情动能开关在组装期间改变，请重新开始本回合');
    const owner = ctx.meta.roundOwnership;
    if (!control.enabled || !slot || ctx.meta.isEnhancedOpening || !owner) return ctx;
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    ctx.abortSignal?.addEventListener('abort', abort, { once: true });
    const featureLive = () => {
      const live = readPlotVectorControl();
      if (controller.signal.aborted || !live.enabled || live.epoch !== control.epoch)
        throw new Error('剧情动能已取消；未提交的回合不会扣次数');
    };
    // Same save and load (owner), and the feature still on for this attempt.
    const guard = () => { owner.guard(); featureLive(); };
    // Once the story is saved, switching the feature off no longer stops the rest of the round.
    ctx.meta.plotVectorGuard = () => { owner.guard(); if (!owner.saved) featureLive(); };
    const id = `${slot.profileId}/${slot.slotId}/${ctx.roundNumber}`;
    try {
      guard();
      let state: VectorState | undefined, before: SavedElement[] | undefined, prepared: PreparedVector | undefined;
      try {
        state = cloneDeep(readVectorState(this.state.get(P.plotVector)));
        before = projectSavedElements(ctx.stateSnapshot, { includeEnvironment: true }).entries;
        prepared = prepareVector(state, before, id, projectNativeInput(ctx.stateSnapshot, this.nativeRules), this.supplyRules);
      } catch (error) {
        guard();
        degraded('mainGame.toast.vectorNotComputed', '本回合剧情动能没有算出来，剧情照常进行。', error);
      }
      guard();
      // The round's opening plays this trip in miniature above the input (PO 2026-10-01 C). Display only: a
      // failure here never touches the round.
      if (state && prepared) {
        try {
          const supply = this.supplyRules ? supplyHandInfo(this.supplyRules, state.supply ?? initialSupply(this.supplyRules)) : {};
          eventBus.emit('plotVector:round-started', roundOpening(state, prepared, supply));
        } catch (error) { console.warn('[PlotVector] The round opening could not be prepared:', error); }
      }
      // Without the saved entries of the round start, new entries cannot be told apart; skip the component.
      if (state && before) this.attempt = { ctx, owner, controller, guard, state, id, before, prepared, slot, gained: [], drawn: [],
        release: () => ctx.abortSignal?.removeEventListener('abort', abort) };
      const active = ctx.meta.plotVectorPromptMode === true;
      const mode = active ? this.promptPolicy?.mode : undefined;
      const additions: AIMessage[] = [];
      const sources: string[] = [];
      if (mode) { additions.push({ role: 'system', content: mode }); sources.push('plot-vector-mode'); }
      if (prepared?.prompt) { additions.push({ role: 'system', content: prepared.prompt }); sources.push('plot-vector'); }
      // The ability block goes with the request that writes the round's entries (Step2, or the single call),
      // late and optional (I22); its block is lifted out of the reply before the JSON is parsed (I21).
      const block = active ? this.promptPolicy?.abilityBlock : undefined;
      if (block) {
        ctx.meta.responseSidecars = [...(ctx.meta.responseSidecars ?? []).filter(tag => tag !== block.tag), block.tag];
        const message: AIMessage = { role: 'system', content: block.prompt };
        if (ctx.meta.splitStep2Messages) {
          const placed = beforeLastUser(ctx.meta.splitStep2Messages, ctx.meta.splitStep2Sources, [message], ['ability-block']);
          ctx.meta.splitStep2Messages = placed.messages;
          ctx.meta.splitStep2Sources = placed.sources;
        } else { additions.push(message); sources.push('ability-block'); }
      }
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
  /**
   * Right before the round is written: accept this round's trip and bind the round's new abilities to the
   * entries that are actually being saved, so cards are written together with the round (rebuild plan §6).
   */
  async beforeSave(ctx: PipelineContext): Promise<void> {
    const a = this.attempt;
    if (!a || a.ctx.generationId !== ctx.generationId) return;
    a.guard();
    let next = a.state;
    if (a.prepared && a.state.last?.id !== a.prepared.id) {
      try {
        next = acceptVector(a.state, a.prepared, this.supplyRules);
        const rules = this.supplyRules, hand = next.supply;
        if (rules && hand?.lastDrawn) {
          const info = supplyHandInfo(rules, hand);
          a.drawn = hand.lastDrawn.flatMap(id => {
            const [name] = supplyNames(rules, hand, [id]);
            return name && info[id] ? [{ name, tier: info[id].tier }] : [];
          });
        } else a.drawn = [];
      }
      catch (error) {
        a.guard();
        // The story and its items are saved as usual; this round's momentum and growth do not advance.
        degraded('mainGame.toast.vectorNotSettled', '本回合剧情动能没有结算，剧情已照常保存。', error);
      }
    }
    a.guard();
    try {
      const snapshot = savedSources(path => this.state.get(path));
      const after = projectSavedElements(snapshot, { includeEnvironment: true }).entries;
      const policy = this.promptPolicy?.abilityBlock;
      const raw = policy && ctx.meta.plotVectorPromptMode ? ctx.parsedResponse?.sidecars?.[policy.tag] : undefined;
      // Environment tags still in the save but not projectable this time (e.g. two share a name) keep their cards.
      const tags = readPath(snapshot, P.environmentTags);
      const present = new Set((Array.isArray(tags) ? tags : []).flatMap(tag => {
        const name = savedEntryName(tag), id = tag && typeof tag === 'object' ? (tag as Record<string, unknown>).id ?? (tag as Record<string, unknown>).ID : undefined;
        return [...(name ? [`environment:name:${name}`] : []), ...(typeof id === 'string' && id ? [`environment:${id}`] : [])];
      }));
      const bound = bindRoundAbilities(next, a.before, after, raw === undefined ? undefined : readAbilityBlock(raw), id => present.has(id));
      next = bound.state;
      a.gained = bound.gained;
    } catch (error) { console.warn('[PlotVector] This round\'s abilities were not bound; the entries wait for Step3:', error); }
    a.state = next;
    this.state.set(P.plotVector, next);
  }
  /** After the round is saved: tell the player about the cards it brought. Nothing is requested or written. */
  async afterSave(ctx: PipelineContext): Promise<void> {
    const a = this.attempt;
    if (!a || a.ctx.generationId !== ctx.generationId) return;
    try {
      if (a.owner.saved && a.gained.length) this.announce(a.gained);
      if (a.owner.saved && a.drawn.length) this.announceSupply(a.drawn);
    }
    finally { a.gained = []; a.drawn = []; a.release(); }
  }
  /**
   * One short notice per batch of new cards, and a signal for the board entry's badge (I24): the badge glows in
   * the colour of the rarest new card (items and talents carry a tier; PO 2026-09-30 2A).
   */
  private announce(cards: readonly BoundCard[]): void {
    const names = cards.map(card => String(card.task.entry.capability.name ?? card.spec.for));
    const tiers = cards.filter(card => card.spec.type === 'item' || card.spec.type === 'talent')
      .map(card => tierOf(card.rating)).filter((tier): tier is CardTier => !!tier);
    eventBus.emit('ui:toast', { type: 'success', i18nKey: 'mainGame.toast.vectorNewCards', i18nParams: { names: names.join('、'), count: names.length },
      message: `获得新卡：${names.join('、')}`, duration: 4000 });
    eventBus.emit('plotVector:cards-gained', { names, tiers });
  }
  /** Supply cards the round drew: one short notice, and the board entry's badge counts them (3A, I24). */
  private announceSupply(drawn: ReadonlyArray<{ name: LocalizedLabel; tier: CardTier }>): void {
    const zh = drawn.map(d => d.name.zh), en = drawn.map(d => d.name.en);
    eventBus.emit('ui:toast', { type: 'success', i18nKey: 'mainGame.toast.vectorSupplyDrawn',
      i18nParams: { names: zh.join('、'), namesEn: en.join(', '), count: drawn.length }, message: `补给送来新卡：${zh.join('、')}`, duration: 4000 });
    eventBus.emit('plotVector:cards-gained', { names: zh, tiers: drawn.map(d => d.tier) });
  }
  /** Obtained entries whose ability is not usable yet (the saved entries themselves are never touched). */
  abilityBacklog(): BacklogEntry[] {
    const raw = this.state.get(P.plotVector);
    if (!raw) return [];
    return abilityBacklog(readVectorState(raw), projectSavedElements(savedSources(path => this.state.get(path)), { includeEnvironment: true }).entries);
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
   * Step3 hook (rebuild plan §6.4, I3/I20): the backlog — every saved entry without a usable ability, including
   * entries that were there before the feature was on — in one task of the existing step-3 request, at most
   * REPAIR_BATCH per request (fresh entries first). The task carries only the entries, the guidance and the
   * card domain, so on its own it needs no game state. Abilities come back in the task's own reply field, never
   * as writes to the saved entries. Entries with a player retry in flight are never included; each entry is
   * tried automatically in at most AUTO_REPAIR_ROUNDS rounds.
   */
  async abilityRepairTask(): Promise<ExtraRepairTask | null> {
    const policy = this.promptPolicy?.abilityRepair;
    if (!policy || !this.slot() || !readPlotVectorControl().enabled || !this.state.get(P.plotVector)) return null;
    const round = this.state.get<number>(P.roundNumber) ?? 0;
    const batch = this.abilityBacklog().filter(b => !this.manualInFlight.has(b.id) && autoRoundsLeft(b.row, round))
      .sort((x, y) => (x.row.retry?.autoRounds ?? 0) - (y.row.retry?.autoRounds ?? 0)).slice(0, REPAIR_BATCH);
    if (!batch.length) return null;
    const guard = this.repairGuard('能力补生');
    const list = batch.map(b => {
      const description = b.row.task.entry.capability.description, ability = previousAbility(b.row);
      return { id: b.id, type: cardTypeOf(b.row.task.entry), name: b.name, description: typeof description === 'string' ? description : '',
        ...(b.problem ? { problem: b.problem } : {}), ...(ability !== null ? { ability } : {}) };
    });
    return {
      block: `${policy.template.split('{{ITEMS}}').join(JSON.stringify(list, null, 2))}\n\n${policy.guidance}\n\n${CARD_API}`,
      field: policy.field,
      commands: false,
      standalone: true,
      // The request carrying this task is leaving: it is an attempt for every listed entry. Counted now, so a
      // request that fails without a reply still uses up the automatic rounds (`settle` records a reply).
      sent: () => {
        guard();
        const started = cloneDeep(readVectorState(this.state.get(P.plotVector)));
        for (const entry of batch) {
          const row = rowOf(started, entry);
          const base: AbilityRetry = row.retry ?? { attempts: 0, autoRounds: 0 };
          const retry: AbilityRetry = { ...base, attempts: base.attempts + 1, source: 'step3', error: '补生请求没有得到回复',
            ...(base.lastAutoRound === round ? {} : { autoRounds: base.autoRounds + 1, lastAutoRound: round }) };
          delete retry.raw;
          row.retry = retry;
        }
        this.state.set(P.plotVector, started);
      },
      settle: async (output?: unknown) => {
        guard();
        const next = cloneDeep(readVectorState(this.state.get(P.plotVector)));
        const gained: BoundCard[] = [];
        let resolved = true;
        for (const entry of batch) {
          const key = capabilityKey(entry.row.task.entry);
          // Bound in the meantime (e.g. by the player's retry): resolved, nothing to record.
          if (next.cards.some(card => capabilityKey(card.task.entry) === key)) continue;
          const bound = this.recordRetryReply(next, rowOf(next, entry), replyCardFor(output, entry.id), guard);
          if (bound) gained.push(bound); else resolved = false;
        }
        this.state.set(P.plotVector, next);
        if (gained.length) this.announce(gained);
        return resolved;
      },
    };
  }
  /**
   * The player's "regenerate ability" for one obtained entry: a new request, counted and saved before it is
   * sent; earlier failures stay on record. Returns whether the entry now has a usable ability and whether a
   * model request was made. The saved entry itself is never changed.
   */
  async regenerateAbility(entryId: string): Promise<{ bound: boolean; requested: boolean }> {
    const slot = this.slot();
    if (!slot || !readPlotVectorControl().enabled) throw new Error('剧情动能未开启');
    if (this.manualInFlight.has(entryId)) throw new Error('这一条的能力正在补生');
    const guard = this.repairGuard('能力补生');
    this.manualInFlight.add(entryId);
    try {
      guard();
      const state = cloneDeep(readVectorState(this.state.get(P.plotVector)));
      const entry = abilityBacklog(state, projectSavedElements(savedSources(path => this.state.get(path)), { includeEnvironment: true }).entries)
        .find(b => b.id === entryId);
      if (!entry) throw new Error('这一条目前没有需要补生的能力');
      const row = rowOf(state, entry);
      const problem = row.retry?.error ?? row.error;
      const base: AbilityRetry = row.retry ?? { attempts: 0, autoRounds: 0 };
      const retry: AbilityRetry = { ...base, attempts: base.attempts + 1, source: 'manual' };
      delete retry.raw;
      row.retry = retry;
      await this.persistState(slot, state, guard);
      let raw: string;
      try {
        raw = await this.ai.generate({ messages: buildAbilityRetryMessages(row.task.entry, problem),
          usageType: 'main', stream: false, generationId: `ability-retry:${retry.attempts}` });
      } catch (error) {
        guard();
        retry.error = error instanceof Error ? error.message : String(error);
        await this.persistState(slot, state, guard);
        return { bound: false, requested: true };
      }
      guard();
      retry.raw = raw;
      const bound = this.bindRetryReply(state, row, guard);
      await this.persistState(slot, state, guard);
      if (bound) this.announce([bound]);
      return { bound: !!bound, requested: true };
    } finally { this.manualInFlight.delete(entryId); }
  }
  /**
   * Record the reply of a Step3 attempt (already counted when its request left) and bind the ability if it
   * passes the one check. `card` undefined: the reply had no ability for this entry.
   */
  private recordRetryReply(state: VectorState, row: VectorTaskRow, card: unknown, guard: () => void): BoundCard | null {
    const retry: AbilityRetry = { ...(row.retry ?? { attempts: 1, autoRounds: 1 }), source: 'step3' };
    delete retry.raw;
    row.retry = retry;
    if (card === undefined) { retry.error = '补生回复没有给出这一条的能力'; return null; }
    retry.raw = JSON.stringify(card);
    return this.bindRetryReply(state, row, guard);
  }
  /**
   * Bind the latest retry reply of a row if it passes the one check (§5): the card replaces any earlier one and
   * the row is dropped (only failures are kept). A failure is recorded on that retry; the first attempt's
   * failure stays on record. Nothing is sent.
   */
  private bindRetryReply(state: VectorState, row: VectorTaskRow, guard: () => void): BoundCard | null {
    const retry = row.retry;
    if (retry?.raw === undefined) return null;
    try {
      const bound = bindCard(row.task, parseCardReply(retry.raw));
      guard();
      state.cards = [...state.cards.filter(c => c.task.entry.id !== row.task.entry.id), bound];
      state.tasks = state.tasks.filter(t => t !== row);
      return bound;
    } catch (error) {
      guard();
      retry.error = error instanceof Error ? error.message : String(error);
      return null;
    }
  }
  /** Save the vector state outside a round (player retry). A failed write never leaves the new state in memory. */
  private async persistState(slot: Slot, state: VectorState, guard: () => void): Promise<void> {
    guard();
    const previous = cloneDeep(this.state.get<VectorState>(P.plotVector));
    // set() copies the value into the tree itself.
    this.state.set(P.plotVector, state);
    let committed = false;
    try {
      // The live tree with this branch set; saveGame copies it before its first await.
      // Its own copy: the caller goes on updating `state` after this write.
      await this.saves.saveGame(slot.profileId, slot.slotId, this.state.snapshotWith(P.plotVector, cloneDeep(state)), undefined, { guard, committed: () => { committed = true; } });
    } catch (error) {
      if (!committed) this.state.set(P.plotVector, previous);
      throw error;
    }
  }
}
