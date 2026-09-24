import type {
  AccountDef,
  ActionEntry,
  ChannelId,
  CompiledBoard,
  CompiledCell,
  CompiledEdge,
  CompiledEffect,
  Delta,
  DecisionPoint,
  EndRule,
  EventStatus,
  LocalizedLabel,
  ModifierRecord,
  NetVector,
  OperationDef,
  OwnerRef,
  PendingCosts,
  PortId,
  ReasonArgs,
  ReasonCode,
  RunServices,
  RunDone,
  RunResult,
  Settlement,
  TraceEvent,
  TraceEventType,
  ScriptAcceptanceInput,
  ScriptProgramRef,
  ScriptState,
} from './types';
import { SCALAR_KEY } from './types';
import { AccountStore } from './accounts';
import { TriggerCounter } from './policies';
import { adjacencyViewFor, multiplierFor, type ActiveModifier, type AdjacencyView } from './modifiers';
import { aggregateVisits, buildVectorPacket, netVector } from './readout';
import { evaluateCondition } from './conditions';
import { availableUses, stateOf, settleCards } from './card-state';

export const SHUTTLE_ACCOUNT = 'shuttle';
export const SCRIPT_EXTREMES_DERIVATION_VERSION = 'trace-extremes-v1';

class HardBudgetExceeded extends Error {}

/** Every account a board can touch: shuttle, card stores, cell buffers. */
export function accountDefsOf(board: CompiledBoard): AccountDef[] {
  const defs: AccountDef[] = [
    {
      id: SHUTTLE_ACCOUNT,
      owner: { kind: 'shuttle', id: SHUTTLE_ACCOUNT },
      encoding: 'channelVector',
      persist: 'run',
      label: { zh: 'shuttle', en: 'shuttle' },
    },
  ];
  for (const card of board.cards) for (const a of card.accounts ?? []) defs.push(a);
  for (const cell of board.cells) if (cell.buffer) defs.push(cell.buffer);
  return defs;
}

interface Visit {
  id: string;
  cell: CompiledCell;
  entryPort: PortId;
  ordinal: number;
}

interface OpOutcome {
  deltas: Delta[];
  modifiers: ModifierRecord[];
  status: EventStatus;
  reason?: string;
  reasonCode?: ReasonCode;
  reasonArgs?: ReasonArgs;
}

/**
 * Pure settlement runner implementing the v0.3 visit order:
 * arrive -> record visit -> windows -> freeze adjacency -> beforeCard -> onVisit -> afterCard
 * -> select & lock edge -> onExit -> visitComplete -> onTraverse -> next cell / end.
 */
/**
 * The trip length for one run (D89). Rounding is declared here and nowhere else:
 * the raw figure is floored, so a part-paid step never buys a whole one, and then
 * clamped into [0, nMax]. `nMax` limits the initial input only; the safety ceiling
 * (`budget.maxVisits`) is separate and cannot be lifted by anything in the run.
 */
export function resolveVisitBudget(board: CompiledBoard, settlement: Settlement): number {
  const raw = settlement.visitBudget ?? board.traversal.nDefault;
  return Math.min(board.traversal.nMax, Math.max(0, Math.floor(raw)));
}

export function run(board: CompiledBoard, settlement: Settlement, services: RunServices = {}): RunResult {
  let ctx: RunContext | null = null;
  try {
    ctx = new RunContext(board, settlement, services);
    return ctx.execute();
  } catch (err) {
    // Every failure (hard budget, malformed fixture, invalid account) is reported through the
    // three-state result; callers never need their own try/catch (v0.3 section D).
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason, partialTrace: ctx?.trace ?? [] };
  }
}

/** Persistent snippet state belongs to a card instance running an immutable program. */
export function scriptStateKey(cardId: string, ref: ScriptProgramRef): string {
  return `${cardId}:${ref.hash}`;
}

/** Stable private-account identity shared by the runner and generated snippets. */
export function scriptStoreAccountId(cardId: string, ref: ScriptProgramRef): string {
  return `script-store:${cardId}:${ref.hash.slice(0, 12)}`;
}

/** Fixture-level checks the type system cannot express. Throws with a readable reason. */
function validateBoard(board: CompiledBoard, defs: AccountDef[]): void {
  const byId = new Map(defs.map((d) => [d.id, d] as const));
  for (const cell of board.cells) {
    if (!cell.capacity) continue;
    const dest = byId.get(cell.capacity.destination);
    if (!dest) throw new Error(`cell ${cell.id}: capacity destination ${cell.capacity.destination} is not an account`);
    if (dest.encoding !== 'channelVector') {
      throw new Error(`cell ${cell.id}: capacity overflow must target a channelVector account, ${dest.id} is ${dest.encoding}`);
    }
  }
  if (!board.cells.some((c) => c.id === board.start.cell)) throw new Error(`start cell ${board.start.cell} does not exist`);
  // The rule ceiling must stay inside the safety ceiling: nothing a card or a condition
  // does to the trip length may lift the guard that stops a runaway run (D89).
  const { nMax, nDefault } = board.traversal;
  if (!Number.isInteger(nMax) || nMax < 0) throw new Error(`traversal.nMax must be a non-negative integer, got ${nMax}`);
  if (!Number.isInteger(nDefault) || nDefault < 0) throw new Error(`traversal.nDefault must be a non-negative integer, got ${nDefault}`);
  if (nMax > board.budget.maxVisits) throw new Error(`traversal.nMax ${nMax} exceeds the safety ceiling budget.maxVisits ${board.budget.maxVisits}`);
  if (nDefault > nMax) throw new Error(`traversal.nDefault ${nDefault} exceeds traversal.nMax ${nMax}`);
  for (const card of board.cards) {
    if (card.usage?.kind === 'consumable') {
      if (!Number.isSafeInteger(card.usage.initialStock) || card.usage.initialStock < 0 || !Number.isSafeInteger(card.usage.maxStock) || card.usage.maxStock < card.usage.initialStock) throw new Error(`invalid card stock: ${card.id}`);
      const supply = card.usage.supply;
      if (supply && (!Number.isSafeInteger(supply.amount) || supply.amount <= 0 || !supply.sourceId.trim() || !supply.label.zh.trim() || !supply.label.en.trim())) throw new Error(`invalid card supply: ${card.id}`);
    } else if (card.usage?.kind === 'rechargeable') {
      if (!Number.isSafeInteger(card.usage.initialCharges) || card.usage.initialCharges < 0 || !Number.isSafeInteger(card.usage.maxCharges) || card.usage.maxCharges < card.usage.initialCharges) throw new Error(`invalid card charges: ${card.id}`);
    }
    const recharge = card.usage?.kind === 'rechargeable' ? card.usage.recharge : undefined;
    for (const rule of [card.growth, recharge]) {
      if (!rule) continue;
      if (!Number.isSafeInteger(rule.amount) || rule.amount < 0 || !['owned', 'equipped'].includes(rule.scope)) throw new Error(`invalid progression: ${card.id}`);
      if (rule.condition && (!board.channels.some((c) => c.id === rule.condition?.channel) || !Number.isFinite(rule.condition.atLeast))) throw new Error(`invalid progression condition: ${card.id}`);
    }
  }
  for (const object of [...board.cards, ...board.cells, ...board.edges]) for (const effect of object.effects) {
    for (const op of effect.operations) {
      if (op.op !== 'addVisits' && op.op !== 'scaleRemainingVisits') continue;
      if (!['beforeCard', 'onVisit', 'afterCard'].includes(effect.event)) throw new Error('step effects must run before exit selection');
      if (op.op === 'addVisits' ? !Number.isSafeInteger(op.amount) || op.amount < 0 : !Number.isFinite(op.factor) || op.factor < 1) throw new Error('invalid step extension');
    }
  }
}

class RunContext {
  readonly trace: TraceEvent[] = [];
  private readonly accounts: AccountStore;
  private readonly counter = new TriggerCounter();
  private readonly visitOrdinals = new Map<string, number>();
  private readonly locals = new Map<string, Record<string, number>>();
  private readonly samples: NetVector[] = [];
  private readonly pendingCosts: PendingCosts = { edgeCosts: {}, talentCharges: {}, itemUses: {} };
  private eventSeq = 0;
  private laps = 0;
  private visits = 0;
  private mode: string;
  /** Initial budget plus traceable step effects; consumed in visits (PO D105). */
  private tripLength: number;
  private readonly usedCards = new Set<string>();
  private readonly grownCards = new Set<string>();
  private readonly chargedCards = new Set<string>();
  private readonly scriptDirectionCounts = new Map<string, number>();
  private readonly scriptRunStates = new Map<string, ScriptState>();
  private readonly scriptRunStateKeys = new Map<string, readonly string[]>();
  private readonly scriptTriggerCounts = new Map<string, number>();
  /** Set by a return card during this visit; consumed when the next hop is chosen. */
  private turnPending = false;

  constructor(
    private readonly board: CompiledBoard,
    private readonly settlement: Settlement,
    private readonly services: RunServices,
  ) {
    const defs = accountDefsOf(board);
    validateBoard(board, defs);
    this.mode = (board.modes ?? ['normal'])[0] ?? 'normal';
    this.tripLength = resolveVisitBudget(board, settlement);
    if (!Number.isSafeInteger(this.tripLength)) throw new Error('invalid initial visit budget');
    for (const card of board.cards) {
      const state = stateOf(card, settlement.cardStates);
      const withinUsageLimit = card.usage?.kind === 'consumable'
        ? state.stock <= card.usage.maxStock
        : card.usage?.kind === 'rechargeable' ? state.charges <= card.usage.maxCharges : true;
      if (![state.stacks, state.stock, state.charges].every((n) => Number.isSafeInteger(n) && n >= 0) || !withinUsageLimit) throw new Error(`invalid initial card state: ${card.id}`);
    }
    this.accounts = new AccountStore(defs, settlement.carriedAccounts, settlement.round);
    for (const [ch, v] of Object.entries(board.startPayload)) this.accounts.deposit(SHUTTLE_ACCOUNT, ch, v);
  }

  execute(): RunResult {
    let cellId = this.board.start.cell;
    let entryPort = this.board.start.entryPort;
    // A trip of zero cells is legal and means exactly that: nothing is visited and the
    // starting payload is the result.
    if (this.stopsOnTripLength() && this.tripLength === 0) return this.finish('visitBudget');
    for (;;) {
      const cell = this.cell(cellId);
      // Gameplay budget (maxVisits): settle by rule when declared, otherwise fail. Checked before
      // the visit is counted so `visits` always equals the number of `visit` trace events.
      if (this.visits + 1 > this.board.budget.maxVisits) {
        if (this.hasEndRule('budgetExhausted')) return this.finish('budgetExhausted');
        throw new HardBudgetExceeded(`visit budget ${this.board.budget.maxVisits} exceeded`);
      }
      const ordinal = (this.visitOrdinals.get(cellId) ?? 0) + 1;
      this.visitOrdinals.set(cellId, ordinal);
      this.visits += 1;
      const visit: Visit = { id: `${cellId}#${ordinal}`, cell, entryPort, ordinal };
      this.turnPending = false;
      this.counter.newVisit();
      this.push({ eventType: 'visit', visitId: visit.id, cellId, entryPort, status: 'info' });

      // Windows (talent) and planned item uses come before any computation.
      const active: ActiveModifier[] = [];
      const oneShot: CompiledEffect[] = [];
      const pending = this.talentWindow(visit, active);
      if (pending) return pending;
      this.plannedItems(visit, oneShot);

      const view = adjacencyViewFor(this.board, cellId, this.settlement.layout.placements);
      // Cell-owned modifiers (resonance) are active only while the shuttle is on that cell and
      // pass the same gates as any effect: entry port, mode condition, trigger policy (D74 #4).
      for (const e of cell.effects) {
        if (e.event !== 'modifyOperation' || !e.modifier) continue;
        const gate = this.eligibility(e, visit, view);
        if (!gate.ok) {
          this.push({ eventType: 'effect', visitId: visit.id, cellId, owner: e.owner, effectId: e.id, status: gate.status, reason: gate.reason, reasonCode: gate.reasonCode, reasonArgs: gate.reasonArgs });
          continue;
        }
        active.push({ source: e.owner, def: e.modifier });
      }

      this.runEffects(visit, cell.effects.filter((e) => e.event === 'beforeCard'), active, view);
      this.pickup(visit);
      const card = this.placedCard(cellId);
      const onVisit = [...oneShot, ...(card ? card.effects.filter((e) => e.event === 'onVisit') : [])];
      this.runEffects(visit, onVisit, active, view);
      if (card?.scriptProgram) this.runScriptCard(visit, card.id, card.scriptProgram, active, view);
      this.afterCard(visit, active, view);

      // The trip is counted in visits, so the last cell is settled where it stands: no
      // extra step is taken just to turn around (D89, PO confirmed).
      if (this.stopsOnTripLength() && this.visits >= this.tripLength) {
        this.runEffects(visit, cell.effects.filter((e) => e.event === 'onExit'), active, view);
        this.visitComplete(visit);
        return this.finish('visitBudget');
      }

      const exit = this.selectExit(visit);
      if (exit.kind === 'awaiting') return { status: 'awaiting', decisionPoint: exit.decisionPoint, partialTrace: this.trace };
      if (exit.kind === 'failed') return { status: 'failed', reason: exit.reason, partialTrace: this.trace };
      if (exit.kind === 'terminal') {
        this.runEffects(visit, cell.effects.filter((e) => e.event === 'onExit'), active, view);
        this.visitComplete(visit);
        return this.finish('terminalVisitComplete');
      }
      const edge = exit.edge;
      this.push({
        eventType: 'route',
        visitId: visit.id,
        cellId,
        edgeId: edge.id,
        status: 'info',
        reasonCode: exit.reasonCode,
        reason: exit.reason,
      });
      this.runEffects(visit, cell.effects.filter((e) => e.event === 'onExit'), active, view);
      this.visitComplete(visit);

      // Traverse.
      for (const [k, v] of Object.entries(edge.cost ?? {})) {
        this.pendingCosts.edgeCosts[k] = (this.pendingCosts.edgeCosts[k] ?? 0) + v;
      }
      this.push({ eventType: 'traverse', visitId: visit.id, edgeId: edge.id, status: 'info' });
      this.runEffects(visit, edge.effects.filter((e) => e.event === 'onTraverse'), active, view);
      if (edge.lapBoundary) {
        this.laps += 1;
        const lapRule = this.board.endRules.find((r): r is Extract<EndRule, { kind: 'lapCount' }> => r.kind === 'lapCount');
        if (lapRule && this.laps >= lapRule.laps) return this.finish('lapCount');
      }
      if ('exit' in edge.to) {
        if (!this.hasEndRule('exitEdge')) return { status: 'failed', reason: `edge ${edge.id} leaves the board but exitEdge is not an end rule`, partialTrace: this.trace };
        return this.finish('exitEdge');
      }
      cellId = edge.to.cell;
      entryPort = edge.to.port;
    }
  }

  // ── windows ──────────────────────────────────────────────────────────

  private talentWindow(visit: Visit, active: ActiveModifier[]): RunResult | null {
    if (!visit.cell.windows?.includes('talent')) return null;
    for (const talent of this.board.talents.filter((t) => t.windowCell === visit.cell.id)) {
      const decision = this.settlement.actionLog.find(
        (a): a is Extract<ActionEntry, { kind: 'talent' }> =>
          a.kind === 'talent' && a.cellId === visit.cell.id && a.visitOrdinal === visit.ordinal && a.talentId === talent.id,
      );
      const chargesLeft = this.settlement.talentCharges[talent.id] ?? 0;
      if (!decision) {
        const decisionPoint: DecisionPoint = {
          settlementId: this.settlement.id,
          cellId: visit.cell.id,
          visitOrdinal: visit.ordinal,
          windowType: 'talent',
          talentId: talent.id,
          chargesLeft,
          options: [
            { id: 'activate', label: { zh: 'activate', en: 'activate' } },
            { id: 'skip', label: { zh: 'skip', en: 'skip' } },
          ],
        };
        return { status: 'awaiting', decisionPoint, partialTrace: this.trace };
      }
      if (decision.choice === 'skip') {
        this.push({ eventType: 'window', visitId: visit.id, cellId: visit.cell.id, owner: { kind: 'talent', id: talent.id }, status: 'notTriggered', reason: 'skipped', reasonCode: 'skipped' });
        continue;
      }
      if (chargesLeft <= 0) {
        this.push({ eventType: 'window', visitId: visit.id, cellId: visit.cell.id, owner: { kind: 'talent', id: talent.id }, status: 'notTriggered', reason: 'no charges left', reasonCode: 'noCharges' });
        continue;
      }
      active.push({ source: { kind: 'talent', id: talent.id }, def: talent.modifier });
      this.push({ eventType: 'window', visitId: visit.id, cellId: visit.cell.id, owner: { kind: 'talent', id: talent.id }, status: 'applied', reason: 'activated', reasonCode: 'activated' });
    }
    return null;
  }

  private plannedItems(visit: Visit, oneShot: CompiledEffect[]): void {
    const planned = this.settlement.actionLog.filter(
      (a): a is Extract<ActionEntry, { kind: 'useItem' }> =>
        a.kind === 'useItem' && a.cellId === visit.cell.id && a.visitOrdinal === visit.ordinal,
    );
    for (const use of planned) {
      const item = this.board.items.find((i) => i.id === use.itemId);
      const owner: OwnerRef = { kind: 'item', id: use.itemId };
      if (!item) {
        this.push({ eventType: 'item', visitId: visit.id, cellId: visit.cell.id, owner, status: 'notTriggered', reason: 'unknown item', reasonCode: 'unknownItem' });
        continue;
      }
      const usesLeft = this.settlement.itemUses[item.id] ?? 0;
      if (usesLeft <= 0) {
        this.push({ eventType: 'item', visitId: visit.id, cellId: visit.cell.id, owner, status: 'notTriggered', reason: 'no uses left', reasonCode: 'noUses' });
        continue;
      }
      if (oneShot.some((e) => e.owner.id === item.id)) continue;
      oneShot.push({
        id: `item:${item.id}@${visit.id}`,
        owner,
        event: 'onVisit',
        order: -1,
        operations: item.operations,
        triggerPolicy: { limitScope: 'visit', maxTriggers: 'unlimited' },
        source: item.source,
        label: item.label,
      });
    }
  }

  // ── phases ───────────────────────────────────────────────────────────

  private pickup(visit: Visit): void {
    const buffer = visit.cell.buffer;
    if (!buffer) return;
    const mode = this.settlement.options.pickup;
    if (mode === 'none') return;
    if (mode === 'explicit') {
      const planned = this.settlement.actionLog.some(
        (a) => a.kind === 'pickup' && a.cellId === visit.cell.id && a.visitOrdinal === visit.ordinal,
      );
      if (!planned) return;
    }
    const deltas: Delta[] = [];
    for (const [ch, amt] of Object.entries(this.accounts.byChannel(buffer.id))) {
      if (amt <= 0) continue;
      const taken = this.accounts.withdraw(buffer.id, ch, amt);
      const before = this.accounts.amount(SHUTTLE_ACCOUNT, ch);
      this.accounts.deposit(SHUTTLE_ACCOUNT, ch, taken);
      deltas.push({ account: buffer.id, channelOrField: ch, before: amt, after: this.accounts.amount(buffer.id, ch) });
      deltas.push({ account: SHUTTLE_ACCOUNT, channelOrField: ch, before, after: this.accounts.amount(SHUTTLE_ACCOUNT, ch) });
    }
    if (deltas.length) {
      this.push({ eventType: 'pickup', visitId: visit.id, cellId: visit.cell.id, owner: { kind: 'cell', id: visit.cell.id }, status: 'applied', deltas });
    }
  }

  private afterCard(visit: Visit, active: ActiveModifier[], view: AdjacencyView): void {
    type Step = { order: number; run: () => void };
    // Both the cell's own `afterCard` rules and the placed card's run here, interleaved by
    // `order`: a card that acts after the cell has finished computing (the return card, D89)
    // needs this phase, and it must not be able to jump the queue.
    const card = this.placedCard(visit.cell.id);
    const steps: Step[] = [...visit.cell.effects, ...(card ? card.effects : [])]
      .filter((e) => e.event === 'afterCard')
      .map((e) => ({ order: e.order, run: () => this.runEffects(visit, [e], active, view) }));
    const cap = visit.cell.capacity;
    if (cap && this.settlement.options.capacityEnabled) {
      steps.push({ order: cap.order, run: () => this.capacity(visit) });
    }
    steps.sort((a, b) => a.order - b.order);
    for (const s of steps) s.run();
  }

  private capacity(visit: Visit): void {
    const rule = visit.cell.capacity!;
    const scope = this.settlement.options.capacityScope;
    const positive = (ch: ChannelId) => this.board.channels.find((c) => c.id === ch)?.pole === 'positive';
    const counted = rule.countedChannels.filter((ch) => scope === 'total' || positive(ch));
    const transferable = rule.transferableChannels.filter((ch) => counted.includes(ch));
    const total = counted.reduce((s, ch) => s + this.accounts.amount(SHUTTLE_ACCOUNT, ch), 0);
    if (total <= rule.cap) {
      this.push({ eventType: 'capacity', visitId: visit.id, cellId: visit.cell.id, owner: { kind: 'cell', id: visit.cell.id }, status: 'notTriggered', reason: `load ${round4(total)} within cap ${rule.cap}`, reasonCode: 'withinCap', reasonArgs: { load: round4(total), cap: rule.cap } });
      return;
    }
    const f = rule.cap / total;
    const deltas: Delta[] = [];
    let dissipated = 0;
    for (const ch of transferable) {
      const have = this.accounts.amount(SHUTTLE_ACCOUNT, ch);
      const over = have * (1 - f);
      if (over <= 0) continue;
      const taken = this.accounts.withdraw(SHUTTLE_ACCOUNT, ch, over);
      const destBefore = this.accounts.amount(rule.destination, ch);
      const { overflow } = this.accounts.deposit(rule.destination, ch, taken);
      dissipated += overflow;
      deltas.push({ account: SHUTTLE_ACCOUNT, channelOrField: ch, before: have, after: this.accounts.amount(SHUTTLE_ACCOUNT, ch) });
      deltas.push({ account: rule.destination, channelOrField: ch, before: destBefore, after: this.accounts.amount(rule.destination, ch) });
    }
    this.push({
      eventType: 'capacity',
      visitId: visit.id,
      cellId: visit.cell.id,
      owner: { kind: 'cell', id: visit.cell.id },
      status: 'applied',
      deltas,
      reason: dissipated > 0 ? `destination full, ${round4(dissipated)} dissipated` : undefined,
      reasonCode: dissipated > 0 ? 'destinationFull' : undefined,
      reasonArgs: dissipated > 0 ? { amount: round4(dissipated) } : undefined,
    });
  }

  private runEffects(visit: Visit, effects: CompiledEffect[], active: ActiveModifier[], view: AdjacencyView): void {
    const sorted = [...effects].sort((a, b) => a.order - b.order);
    for (const effect of sorted) {
      if (effect.event === 'modifyOperation') continue;
      const gate = this.eligibility(effect, visit, view);
      if (!gate.ok) {
        this.push({ eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner: effect.owner, effectId: effect.id, status: gate.status, reason: gate.reason, reasonCode: gate.reasonCode, reasonArgs: gate.reasonArgs });
        continue;
      }
      const attempt = gate;
      const deltas: Delta[] = [];
      const modifiers: ModifierRecord[] = [];
      let status: EventStatus = 'applied';
      let reason: string | undefined;
      let reasonCode: ReasonCode | undefined;
      let reasonArgs: ReasonArgs | undefined;
      for (const op of effect.operations) {
        const out = this.applyOperation(op, effect.owner, attempt.deltaFactor, active, view);
        deltas.push(...out.deltas);
        modifiers.push(...out.modifiers);
        if (out.reason) {
          reason = out.reason;
          reasonCode = out.reasonCode;
          reasonArgs = out.reasonArgs;
        }
        if (out.status !== 'applied') status = out.status;
      }
      if (attempt.deltaFactor !== 1 && !reasonCode) {
        reason = `repeat ${attempt.ordinal}: delta x${attempt.deltaFactor}`;
        reasonCode = 'repeatDiscount';
        reasonArgs = { ordinal: attempt.ordinal, factor: attempt.deltaFactor };
      }
      this.push({ eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner: effect.owner, effectId: effect.id, status, deltas, modifiers, reason, reasonCode, reasonArgs });
      const effective = deltas.some((d) => d.before !== d.after) || (status === 'applied' && effect.operations.some((op) => op.op === 'turnShuttle' || op.op === 'setMode'));
      if (effective && effect.owner.kind === 'card') this.usedCards.add(effect.owner.id);
      if (effective && effect.owner.kind === 'item') this.pendingCosts.itemUses[effect.owner.id] = 1;
      if (effective) for (const mod of modifiers) if (mod.source.kind === 'talent') this.pendingCosts.talentCharges[mod.source.id] = 1;
    }
  }

  private runScriptCard(
    visit: Visit,
    cardId: string,
    ref: { id: string; hash: string },
    active: ActiveModifier[],
    view: AdjacencyView,
  ): void {
    const owner: OwnerRef = { kind: 'card', id: cardId };
    const runtime = this.services.scripts;
    if (!runtime) {
      this.push({
        eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner,
        effectId: `script:${ref.id}`, status: 'notTriggered', reason: 'script runtime unavailable',
        programId: ref.id, programHash: ref.hash,
      });
      return;
    }
    // Same use gate as ordinary card effects (`eligibility`): a card with no uses left does not run.
    const def = this.board.cards.find((c) => c.id === cardId);
    if (def?.usage && availableUses(def, stateOf(def, this.settlement.cardStates)) <= 0) {
      this.push({
        eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner,
        effectId: `script:${ref.id}`, status: 'notTriggered', reason: 'no uses left', reasonCode: 'noUses', reasonArgs: {},
        programId: ref.id, programHash: ref.hash,
      });
      return;
    }
    const key = scriptStateKey(cardId, ref);
    const persistentState = this.settlement.scriptStates?.[key]
      ?? this.settlement.scriptStates?.[ref.hash]
      ?? runtime.initialState(ref)
      ?? {};
    const directionKey = `${key}:${visit.cell.id}:${visit.entryPort}`;
    const directionVisitOrdinal = (this.scriptDirectionCounts.get(directionKey) ?? 0) + 1;
    this.scriptDirectionCounts.set(directionKey, directionVisitOrdinal);
    const output = runtime.visit({
      ref, cardId, cellId: visit.cell.id, entryPort: visit.entryPort,
      visitOrdinal: visit.ordinal, directionVisitOrdinal, totalVisitsSoFar: this.visits,
      remainingVisits: Math.max(0, this.tripLength - this.visits), mode: this.mode,
      shuttle: Object.freeze(this.shuttleSnapshot()),
      selfStore: Object.freeze(this.scriptStoreSnapshot(cardId, ref)),
      neighbors: Object.freeze(view.neighbors.map((n) => Object.freeze({
        cellId: n.cellId, occupied: n.hasCard,
        publicTags: Object.freeze([...n.tags, ...n.cardTags]),
      }))),
      runState: Object.freeze({ ...(this.scriptRunStates.get(key) ?? {}) }),
      runStateKeys: this.scriptRunStateKeys.get(key) ?? null,
      persistentState: Object.freeze({ ...persistentState }),
      seed: `${this.settlement.seed}:${this.settlement.id}:${ref.hash}:${visit.id}`,
    });
    if (!output.ok) {
      this.push({
        eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner,
        effectId: `script:${ref.id}`, status: 'notTriggered', reason: output.reason,
        programId: ref.id, programHash: ref.hash,
      });
      return;
    }
    this.scriptRunStates.set(key, { ...output.runState });
    this.scriptRunStateKeys.set(key, [...output.runStateKeys]);
    const deltas: Delta[] = [];
    const modifiers: ModifierRecord[] = [];
    let status: EventStatus = 'applied';
    let reason: string | undefined;
    let reasonCode: ReasonCode | undefined;
    let reasonArgs: ReasonArgs | undefined;
    for (const operation of output.operations) {
      const out = this.applyOperation(operation, owner, 1, active, view);
      deltas.push(...out.deltas);
      modifiers.push(...out.modifiers);
      if (out.status !== 'applied') status = out.status;
      if (out.reason) {
        reason = out.reason;
        reasonCode = out.reasonCode;
        reasonArgs = out.reasonArgs;
      }
    }
    if (output.operations.length > 0) {
      this.scriptTriggerCounts.set(key, (this.scriptTriggerCounts.get(key) ?? 0) + 1);
    }
    const effective = deltas.some((d) => d.before !== d.after)
      || output.operations.some((op) => op.op === 'turnShuttle' || op.op === 'setMode');
    if (effective) this.usedCards.add(cardId);
    this.push({
      eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner,
      effectId: `script:${ref.id}`, status, deltas, modifiers, reason, reasonCode, reasonArgs,
      programId: ref.id, programHash: ref.hash, scriptEffects: [...output.effectSummary],
    });
  }

  /** Shared gate for effects and modifiers: entry port, mode condition, trigger policy. */
  private eligibility(effect: CompiledEffect, visit: Visit, view: AdjacencyView):
    | { ok: true; ordinal: number; deltaFactor: number }
    | { ok: false; status: 'notTriggered' | 'suppressed'; reason: string; reasonCode: ReasonCode; reasonArgs: ReasonArgs } {
    const card = effect.owner.kind === 'card' ? this.board.cards.find((c) => c.id === effect.owner.id) : undefined;
    if (card?.usage && availableUses(card, stateOf(card, this.settlement.cardStates)) <= 0) {
      return { ok: false, status: 'notTriggered', reason: 'no uses left', reasonCode: 'noUses', reasonArgs: {} };
    }
    if (effect.entryPort && effect.entryPort !== visit.entryPort) {
      return {
        ok: false, status: 'notTriggered',
        reason: `entry port ${visit.entryPort} does not match ${effect.entryPort}`,
        reasonCode: 'entryPortMismatch', reasonArgs: { expected: effect.entryPort },
      };
    }
    if (effect.condition?.mode && effect.condition.mode !== this.mode) {
      return {
        ok: false, status: 'notTriggered',
        reason: `mode ${this.mode} does not match ${effect.condition.mode}`,
        reasonCode: 'modeMismatch', reasonArgs: { expected: effect.condition.mode, actual: this.mode },
      };
    }
    if (effect.condition?.test && !evaluateCondition(effect.condition.test, {
      neighborCardTags: view.neighbors.map((n) => n.cardTags),
      read: (value) => {
        switch (value.kind) {
          case 'visitOrdinal': return visit.ordinal;
          case 'remainingVisits': return Math.max(0, this.tripLength - this.visits);
          case 'local': return this.locals.get(`${effect.owner.kind}:${effect.owner.id}`)?.[value.key] ?? 0;
          case 'account': {
            if (!this.accounts.has(value.account)) return undefined;
            const def = this.accounts.def(value.account);
            // Cards may inspect their own store and the shuttle, not arbitrary other stores.
            if (value.account !== SHUTTLE_ACCOUNT && (def.owner.kind !== effect.owner.kind || def.owner.id !== effect.owner.id)) return undefined;
            const knownChannel = def.encoding === 'scalar' ? value.channel === SCALAR_KEY : this.board.channels.some((c) => c.id === value.channel);
            return knownChannel ? this.accounts.amount(value.account, value.channel) : undefined;
          }
        }
      },
    })) return { ok: false, status: 'notTriggered', reason: 'condition not met', reasonCode: 'conditionNotMet', reasonArgs: {} };
    const attempt = this.counter.attempt(effect.id, effect.triggerPolicy);
    if (!attempt.allowed) {
      return {
        ok: false, status: 'suppressed',
        reason: `trigger ${attempt.ordinal} exceeds maxTriggers ${String(effect.triggerPolicy.maxTriggers)}`,
        reasonCode: 'maxTriggers', reasonArgs: { n: String(effect.triggerPolicy.maxTriggers) },
      };
    }
    return { ok: true, ordinal: attempt.ordinal, deltaFactor: attempt.deltaFactor };
  }

  /** Can the shuttle afford an edge's cost with what is left of the host-provided resources? */
  private shortfall(edge: CompiledEdge): { reason: string; args: ReasonArgs } | null {
    for (const [k, v] of Object.entries(edge.cost ?? {})) {
      const left = (this.settlement.resources[k] ?? 0) - (this.pendingCosts.edgeCosts[k] ?? 0);
      if (left < v) return { reason: `insufficient ${k}: need ${v}, have ${left}`, args: { resource: k, need: v, have: left } };
    }
    return null;
  }

  private applyOperation(op: OperationDef, owner: OwnerRef, deltaFactor: number, active: ActiveModifier[], view: AdjacencyView): OpOutcome {
    const mod = multiplierFor(active, owner.kind, op.op, view);
    switch (op.op) {
      case 'addVisits':
      case 'scaleRemainingVisits': {
        if (!this.stopsOnTripLength()) throw new Error('step operations require visitBudget ending');
        const before = this.tripLength;
        const remaining = Math.max(0, before - this.visits);
        const delta = op.op === 'addVisits' ? op.amount : remaining * (op.factor - 1);
        const requested = before + Math.floor(delta * mod.multiplier * deltaFactor);
        if (!Number.isSafeInteger(requested) || requested < this.visits) throw new HardBudgetExceeded(`step effect is not a valid trip length; no costs committed`);
        // A card that buys steps can never lift the safety limit: the trip stops at it. Failing the whole
        // run instead would block every round (and every board preview) once cards together, or a growing
        // card, buy past the limit.
        const after = Math.min(requested, this.board.budget.maxVisits);
        this.tripLength = after;
        const capped = requested - after;
        return {
          deltas: [{ account: 'runner', channelOrField: 'visitBudget', before, after }], modifiers: mod.records, status: 'applied',
          ...(capped > 0 ? { reason: `trip capped at ${after} visits, ${capped} dropped`, reasonCode: 'capReached' as const, reasonArgs: { amount: capped } } : {}),
        };
      }
      case 'add': {
        const before = this.accounts.amount(op.target, op.channel);
        const stacks = owner.kind === 'card' ? this.settlement.cardStates?.[owner.id]?.stacks ?? 0 : 0;
        const amount = (op.amount + (op.perStack ?? 0) * stacks) * mod.multiplier * deltaFactor;
        const overflow = amount >= 0
          ? this.accounts.deposit(op.target, op.channel, amount).overflow
          : (this.accounts.withdraw(op.target, op.channel, -amount), 0);
        return {
          deltas: [{ account: op.target, channelOrField: op.channel, before, after: this.accounts.amount(op.target, op.channel) }],
          modifiers: mod.records,
          status: 'applied',
          reason: overflow > 0 ? `cap reached, ${round4(overflow)} dissipated` : undefined,
          reasonCode: overflow > 0 ? 'capReached' : undefined,
          reasonArgs: overflow > 0 ? { amount: round4(overflow) } : undefined,
        };
      }
      case 'scale': {
        const before = this.accounts.amount(op.target, op.channel);
        const delta = (op.factor - 1) * before * mod.multiplier * deltaFactor;
        if (delta >= 0) this.accounts.deposit(op.target, op.channel, delta);
        else this.accounts.withdraw(op.target, op.channel, -delta);
        return { deltas: [{ account: op.target, channelOrField: op.channel, before, after: this.accounts.amount(op.target, op.channel) }], modifiers: mod.records, status: 'applied' };
      }
      case 'convert': {
        const fromBefore = this.accounts.amount(op.target, op.from);
        const toBefore = this.accounts.amount(op.target, op.to);
        // Repeat delta discounts are intentionally limited to add/scale (framework D64).
        // Generated fixed-amount conversions share this operation kind and the same rule.
        const u = (op.amount !== undefined ? op.amount : fromBefore * op.rate) * mod.multiplier;
        const taken = this.accounts.withdraw(op.target, op.from, u);
        this.accounts.deposit(op.target, op.to, taken * op.efficiency);
        return {
          deltas: [
            { account: op.target, channelOrField: op.from, before: fromBefore, after: this.accounts.amount(op.target, op.from) },
            { account: op.target, channelOrField: op.to, before: toBefore, after: this.accounts.amount(op.target, op.to) },
          ],
          modifiers: mod.records,
          status: 'applied',
        };
      }
      case 'transfer':
        return this.transfer(op, mod.records);
      case 'setMode': {
        const allowed = this.board.modes ?? ['normal'];
        if (!allowed.includes(op.mode)) return { deltas: [], modifiers: [], status: 'notTriggered', reason: `mode ${op.mode} is not declared on the board` };
        const before = this.mode;
        this.mode = op.mode;
        return { deltas: [], modifiers: [], status: 'applied', reason: `mode ${before} -> ${op.mode}` };
      }
      case 'turnShuttle': {
        this.turnPending = true;
        return { deltas: [], modifiers: [], status: 'applied', reason: 'the next hop leaves by the entry port', reasonCode: 'turnRequested' };
      }
      case 'setLocal': {
        const key = `${op.owner.kind}:${op.owner.id}`;
        const bag = this.locals.get(key) ?? {};
        const before = bag[op.key] ?? 0;
        bag[op.key] = op.value;
        this.locals.set(key, bag);
        return { deltas: [{ account: `local:${key}`, channelOrField: op.key, before, after: op.value }], modifiers: [], status: 'applied' };
      }
    }
  }

  private transfer(op: Extract<OperationDef, { op: 'transfer' }>, modifiers: ModifierRecord[]): OpOutcome {
    const fromDef = this.accounts.def(op.from);
    const toDef = this.accounts.def(op.to);
    // Scalar accounts only accept / release authorised shuttle channels (v0.3 section A).
    if (fromDef.encoding === 'scalar' && !(fromDef.allowedOut ?? []).includes(op.toChannel)) {
      return { deltas: [], modifiers, status: 'notTriggered', reason: `account ${op.from} may not release into ${op.toChannel}`, reasonCode: 'notAuthorised', reasonArgs: { account: op.from, channel: op.toChannel } };
    }
    if (toDef.encoding === 'scalar' && !(toDef.allowedIn ?? []).includes(op.fromChannel)) {
      return { deltas: [], modifiers, status: 'notTriggered', reason: `account ${op.to} may not accept ${op.fromChannel}`, reasonCode: 'notAuthorised', reasonArgs: { account: op.to, channel: op.fromChannel } };
    }
    const fromKey = fromDef.encoding === 'scalar' ? SCALAR_KEY : op.fromChannel;
    const toKey = toDef.encoding === 'scalar' ? SCALAR_KEY : op.toChannel;
    const available = this.accounts.amount(op.from, fromKey);
    const spec = op.amount;
    const qty = spec.kind === 'fixed' ? Math.min(spec.value, available) : spec.kind === 'fractionOfSource' ? available * spec.r : available;
    if (qty <= 0) return { deltas: [], modifiers, status: 'notTriggered', reason: 'nothing to transfer', reasonCode: 'nothingToTransfer' };
    const toBefore = this.accounts.amount(op.to, toKey);
    const gain = op.gainAsExtra ?? 0;
    if (!Number.isFinite(gain) || gain < 0) throw new Error('gainAsExtra must be non-negative and finite');
    const taken = this.accounts.withdraw(op.from, fromKey, qty);
    const { overflow } = this.accounts.deposit(op.to, toKey, taken);
    // Reward only the principal actually delivered. Overflow can never mint principal.
    this.accounts.deposit(op.to, toKey, (taken - overflow) * gain);
    let reason: string | undefined;
    let reasonCode: ReasonCode | undefined;
    let reasonArgs: ReasonArgs | undefined;
    if (overflow > 0) {
      if ((toDef.onFull ?? 'dissipate') === 'stayAtSource') {
        this.accounts.deposit(op.from, fromKey, overflow);
        reason = `destination full, ${round4(overflow)} stayed at source`;
        reasonCode = 'stayedAtSource';
      } else {
        reason = `destination full, ${round4(overflow)} dissipated`;
        reasonCode = 'destinationFull';
      }
      reasonArgs = { amount: round4(overflow) };
    }
    return {
      deltas: [
        { account: op.from, channelOrField: fromKey, before: available, after: this.accounts.amount(op.from, fromKey) },
        { account: op.to, channelOrField: toKey, before: toBefore, after: this.accounts.amount(op.to, toKey) },
      ],
      modifiers,
      status: 'applied',
      reason,
      reasonCode,
      reasonArgs,
    };
  }

  // ── routing & end ────────────────────────────────────────────────────

  private selectExit(visit: Visit):
    | { kind: 'edge'; edge: CompiledEdge; reasonCode?: ReasonCode; reason?: string }
    | { kind: 'terminal' }
    | { kind: 'awaiting'; decisionPoint: DecisionPoint }
    | { kind: 'failed'; reason: string } {
    const outgoing = this.board.edges.filter((e) => e.from.cell === visit.cell.id);
    if (visit.cell.windows?.includes('route')) {
      const decision = this.settlement.actionLog.find(
        (a): a is Extract<ActionEntry, { kind: 'route' }> =>
          a.kind === 'route' && a.cellId === visit.cell.id && a.visitOrdinal === visit.ordinal,
      );
      if (!decision) {
        return {
          kind: 'awaiting',
          decisionPoint: {
            settlementId: this.settlement.id,
            cellId: visit.cell.id,
            visitOrdinal: visit.ordinal,
            windowType: 'route',
            options: outgoing.map((e) => {
              const why = this.shortfall(e);
              return why ? { id: e.id, label: e.label, disabled: true, reason: why.reason, reasonCode: 'insufficientResource' as const, reasonArgs: why.args } : { id: e.id, label: e.label };
            }),
          },
        };
      }
      const edge = outgoing.find((e) => e.id === decision.edgeId);
      if (!edge) return { kind: 'failed', reason: `route decision names unknown edge ${decision.edgeId}` };
      const why = this.shortfall(edge);
      return why ? { kind: 'failed', reason: `${why.reason} (edge ${edge.id})` } : { kind: 'edge', edge };
    }
    // One ladder decides the port, so a return card and an endpoint can never both turn
    // the shuttle and cancel each other out (D89 answer): ask for the natural port, let a
    // return card swap it for the way back, and only then fold if that way is closed.
    const natural = visit.cell.ports.find((p) => p !== visit.entryPort) ?? visit.entryPort;
    const back = visit.entryPort;
    const has = (port: PortId): boolean => outgoing.some((e) => e.from.port === port);
    const atEndpoint = !has(natural);
    let port = this.turnPending ? back : natural;
    let reasonCode: ReasonCode | undefined;
    let reason: string | undefined;
    if (this.turnPending) {
      this.turnPending = false;
      if (!has(port)) {
        // Turning here would walk off the board: at the cell the shuttle started from, the
        // way it "came in" is the outside. The only way on is the natural port, so the card
        // changes nothing and must not strand the run.
        port = natural;
        reasonCode = 'turnImpossibleHere';
        reason = `no edge leaves ${visit.cell.id} by the entry port, so the turn cannot happen`;
      } else {
        // Turning where the way ahead was closed anyway buys nothing; say so rather than
        // letting the card look effective.
        reasonCode = atEndpoint ? 'turnRedundantAtEndpoint' : 'turnRequested';
        reason = atEndpoint ? `turn at endpoint ${visit.cell.id} repeats the fold` : `return card turns the shuttle at ${visit.cell.id}`;
      }
    } else if (atEndpoint) {
      if (this.board.traversal.onDeadEnd === 'stop') {
        return this.hasEndRule('terminalVisitComplete') ? { kind: 'terminal' } : { kind: 'failed', reason: `dead end at ${visit.cell.id}` };
      }
      port = back;
      reasonCode = 'foldedAtEndpoint';
      reason = `endpoint ${visit.cell.id}: the shuttle turns around`;
    }
    const candidates = outgoing.filter((e) => e.from.port === port);
    if (candidates.length === 1) {
      const why = this.shortfall(candidates[0]);
      return why ? { kind: 'failed', reason: `${why.reason} (edge ${candidates[0].id})` } : { kind: 'edge', edge: candidates[0], reasonCode, reason };
    }
    if (candidates.length === 0) {
      return this.hasEndRule('terminalVisitComplete') ? { kind: 'terminal' } : { kind: 'failed', reason: `dead end at ${visit.cell.id}` };
    }
    return { kind: 'failed', reason: `ambiguous exits at ${visit.cell.id} without a route window` };
  }

  private stopsOnTripLength(): boolean {
    return this.hasEndRule('visitBudget');
  }

  private visitComplete(visit: Visit): void {
    for (const card of this.board.cards) {
      const equipped = Object.values(this.settlement.layout.placements).includes(card.id);
      const recharge = card.usage?.kind === 'rechargeable' ? card.usage.recharge : undefined;
      for (const [rule, matched] of [[card.growth, this.grownCards], [recharge, this.chargedCards]] as const) {
        if (!rule || (rule.scope === 'equipped' && !equipped)) continue;
        if (!rule.condition || this.accounts.amount(SHUTTLE_ACCOUNT, rule.condition.channel) >= rule.condition.atLeast) matched.add(card.id);
      }
    }
    this.push({ eventType: 'visitComplete', visitId: visit.id, cellId: visit.cell.id, status: 'info' });
    this.samples.push(this.net());
  }

  private finish(endedBy: EndRule['kind']): RunDone {
    // Unconditional round progress also applies to a valid zero-step settlement.
    for (const card of this.board.cards) {
      const equipped = Object.values(this.settlement.layout.placements).includes(card.id);
      if (card.growth && !card.growth.condition && (card.growth.scope === 'owned' || equipped)) this.grownCards.add(card.id);
      const recharge = card.usage?.kind === 'rechargeable' ? card.usage.recharge : undefined;
      if (recharge && !recharge.condition && (recharge.scope === 'owned' || equipped)) this.chargedCards.add(card.id);
    }
    this.push({ eventType: 'end', visitId: 'end', status: 'info', reason: endedBy });
    // Report every declared channel, including the ones that ended at zero: consumers
    // should not have to guess whether a missing key means zero or means "no such channel".
    const shuttle: Record<ChannelId, number> = {};
    for (const c of this.board.channels) shuttle[c.id] = 0;
    Object.assign(shuttle, this.accounts.byChannel(SHUTTLE_ACCOUNT));
    const opts = this.settlement.options.readout;
    const labels = new Map<string, LocalizedLabel>();
    for (const c of this.board.cells) for (const e of c.effects) labels.set(e.id, e.label);
    for (const c of this.board.cards) for (const e of c.effects) labels.set(e.id, e.label);
    for (const e of this.board.edges) for (const x of e.effects) labels.set(x.id, x.label);
    for (const i of this.board.items) labels.set(`item:${i.id}`, i.label);
    const labelOf = (id: string): LocalizedLabel => labels.get(id) ?? labels.get(id.split('@')[0]) ?? { zh: id, en: id };
    const pendingScriptAcceptances: ScriptAcceptanceInput[] = [];
    const extremes = deriveShuttleExtremes(this.board, this.trace);
    for (const card of this.board.cards) {
      const ref = card.scriptProgram;
      if (!ref) continue;
      const key = scriptStateKey(card.id, ref);
      const persistentState = this.settlement.scriptStates?.[key]
        ?? this.settlement.scriptStates?.[ref.hash]
        ?? this.services.scripts?.initialState(ref)
        ?? {};
      pendingScriptAcceptances.push({
        ref, cardId: card.id,
        wasEquipped: Object.values(this.settlement.layout.placements).includes(card.id),
        wasTriggered: (this.scriptTriggerCounts.get(key) ?? 0) > 0,
        triggerCount: this.scriptTriggerCounts.get(key) ?? 0,
        visitCount: this.visits,
        finalShuttle: { ...shuttle }, peakShuttle: extremes.peak, minShuttle: extremes.minimum,
        derivationVersion: SCRIPT_EXTREMES_DERIVATION_VERSION,
        persistentState: { ...persistentState },
        runState: { ...(this.scriptRunStates.get(key) ?? {}) },
        seed: `${this.settlement.seed}:${this.settlement.id}:${ref.hash}:accepted`,
      });
    }
    return {
      status: 'done',
      settlementId: this.settlement.id,
      endedBy,
      finalState: { shuttle, mode: this.mode, net: this.net(), accounts: this.accounts.summary() },
      aggregation: aggregateVisits(this.samples, this.board.dimensions),
      vectorPacket: buildVectorPacket(this.settlement.id, shuttle, this.board.dimensions, this.board.channels, opts, this.trace, SHUTTLE_ACCOUNT, labelOf),
      pendingCosts: this.pendingCosts,
      pendingCardStates: settleCards(this.board.cards, this.settlement.cardStates ?? {}, this.usedCards, this.grownCards, this.chargedCards),
      pendingAccounts: this.accounts.snapshotAcrossRounds(),
      trace: this.trace,
      visitBudget: this.tripLength,
      visitCounts: Object.fromEntries(this.visitOrdinals),
      visits: this.visits,
      pendingScriptAcceptances: pendingScriptAcceptances.length ? pendingScriptAcceptances : undefined,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private net(): NetVector {
    return netVector(this.accounts.byChannel(SHUTTLE_ACCOUNT), this.board.dimensions, this.board.channels);
  }

  private shuttleSnapshot(): Record<ChannelId, number> {
    const out: Record<ChannelId, number> = {};
    for (const channel of this.board.channels) out[channel.id] = this.accounts.amount(SHUTTLE_ACCOUNT, channel.id);
    return out;
  }

  private scriptStoreSnapshot(cardId: string, ref: ScriptProgramRef): Record<ChannelId, number> {
    const id = scriptStoreAccountId(cardId, ref);
    return this.accounts.has(id) ? this.accounts.byChannel(id) : {};
  }

  private cell(id: string): CompiledCell {
    const c = this.board.cells.find((x) => x.id === id);
    if (!c) throw new Error(`unknown cell ${id}`);
    return c;
  }

  private placedCard(cellId: string) {
    const cardId = this.settlement.layout.placements[cellId];
    return cardId ? this.board.cards.find((c) => c.id === cardId) ?? null : null;
  }

  private hasEndRule(kind: EndRule['kind']): boolean {
    return this.board.endRules.some((r) => r.kind === kind);
  }

  private push(e: Omit<TraceEvent, 'eventId' | 'netAfter' | 'deltas' | 'modifiers'> & { eventType: TraceEventType; deltas?: Delta[]; modifiers?: ModifierRecord[] }): void {
    this.eventSeq += 1;
    // Execution guard (maxEvents) is a hard limit and always fails; it is not a gameplay end rule.
    if (this.eventSeq > this.board.budget.maxEvents) throw new HardBudgetExceeded(`event budget ${this.board.budget.maxEvents} exceeded`);
    this.trace.push({ ...e, eventId: this.eventSeq, deltas: e.deltas ?? [], modifiers: e.modifiers ?? [], netAfter: this.net() });
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** Versioned trace projection used by accepted hooks; raw trace is never exposed to JS. */
export function deriveShuttleExtremes(
  board: CompiledBoard,
  trace: readonly TraceEvent[],
): { peak: Record<ChannelId, number>; minimum: Record<ChannelId, number> } {
  const current: Record<ChannelId, number> = {};
  const peak: Record<ChannelId, number> = {};
  const minimum: Record<ChannelId, number> = {};
  for (const channel of board.channels) {
    const value = Math.max(0, board.startPayload[channel.id] ?? 0);
    current[channel.id] = value;
    peak[channel.id] = value;
    minimum[channel.id] = value;
  }
  for (const event of trace) for (const delta of event.deltas) {
    if (delta.account !== SHUTTLE_ACCOUNT || !(delta.channelOrField in current)) continue;
    current[delta.channelOrField] = delta.after;
    peak[delta.channelOrField] = Math.max(peak[delta.channelOrField], delta.after);
    minimum[delta.channelOrField] = Math.min(minimum[delta.channelOrField], delta.after);
  }
  return { peak, minimum };
}
