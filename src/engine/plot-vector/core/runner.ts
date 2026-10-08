import type {
  AccountDef,
  CardAction,
  ChannelId,
  CompiledBoard,
  CellDef,
  Delta,
  EdgeDef,
  EffectDef,
  EventStatus,
  LocalizedLabel,
  ModifierRecord,
  OperationDef,
  OwnerRef,
  PortId,
  ReasonArgs,
  ReasonCode,
  RunDone,
  RunResult,
  RunServices,
  Settlement,
  TraceEvent,
  TraceEventType,
} from './types';
import { AccountStore } from './accounts';
import { adjacencyViewFor, multiplierFor, type ActiveModifier, type AdjacencyView } from './modifiers';
import { buildVectorPacket, netVector } from './readout';
import { availableUses, settleCards, stateOf } from './card-state';

export const SHUTTLE_ACCOUNT = 'shuttle';

class HardBudgetExceeded extends Error {}

/** Every account a board can touch: the shuttle and the card stores. */
export function accountDefsOf(board: CompiledBoard): AccountDef[] {
  const defs: AccountDef[] = [{
    id: SHUTTLE_ACCOUNT,
    owner: { kind: 'shuttle', id: SHUTTLE_ACCOUNT },
    encoding: 'channelVector',
    persist: 'run',
    label: { zh: 'shuttle', en: 'shuttle' },
  }];
  for (const card of board.cards) for (const a of card.accounts ?? []) defs.push(a);
  return defs;
}

/**
 * The trip length for one run (D89): the raw figure is floored, so a part-paid step never buys a whole
 * one, then clamped into [0, nMax]. `nMax` limits the initial input only; the safety ceiling
 * (`budget.maxVisits`) is separate and cannot be lifted by anything in the run.
 */
function resolveVisitBudget(board: CompiledBoard, settlement: Settlement): number {
  const raw = settlement.visitBudget ?? board.traversal.nDefault;
  return Math.min(board.traversal.nMax, Math.max(0, Math.floor(raw)));
}

/** Run one trip. Every failure comes back as a result; callers never need their own try/catch. */
export function run(board: CompiledBoard, settlement: Settlement, services: RunServices = {}): RunResult {
  let ctx: RunContext | null = null;
  try {
    ctx = new RunContext(board, settlement, services);
    return ctx.execute();
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err), partialTrace: ctx?.trace ?? [] };
  }
}

function validateBoard(board: CompiledBoard): void {
  if (!board.cells.some((c) => c.id === board.start.cell)) throw new Error(`start cell ${board.start.cell} does not exist`);
  // The rule ceiling must stay inside the safety ceiling: nothing a card does to the trip may lift it (D89).
  const { nMax, nDefault } = board.traversal;
  if (!Number.isInteger(nMax) || nMax < 0) throw new Error(`traversal.nMax must be a non-negative integer, got ${nMax}`);
  if (!Number.isInteger(nDefault) || nDefault < 0) throw new Error(`traversal.nDefault must be a non-negative integer, got ${nDefault}`);
  if (nMax > board.budget.maxVisits) throw new Error(`traversal.nMax ${nMax} exceeds the safety ceiling budget.maxVisits ${board.budget.maxVisits}`);
  if (nDefault > nMax) throw new Error(`traversal.nDefault ${nDefault} exceeds traversal.nMax ${nMax}`);
  for (const card of board.cards) {
    const u = card.usage;
    if (u && (!Number.isSafeInteger(u.initialStock) || u.initialStock < 0 || !Number.isSafeInteger(u.maxStock) || u.maxStock < u.initialStock))
      throw new Error(`invalid card stock: ${card.id}`);
  }
  for (const object of [...board.cells, ...board.edges]) for (const effect of object.effects ?? []) {
    for (const op of effect.operations) {
      if (op.op !== 'addVisits' && op.op !== 'scaleRemainingVisits') continue;
      if (!['beforeCard', 'onVisit', 'afterCard'].includes(effect.event)) throw new Error('step effects must run before exit selection');
    }
  }
}

interface Visit {
  id: string;
  cell: CellDef;
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
 * Visit order: arrive → record → resonance (by entry port) → beforeCard → onVisit → the card →
 * afterCard → [trip used up: settle here] → select exit → onExit → visitComplete → traverse → next.
 */
class RunContext {
  readonly trace: TraceEvent[] = [];
  private readonly accounts: AccountStore;
  private readonly visitOrdinals = new Map<string, number>();
  private readonly cardPasses = new Map<string, number>();
  private readonly triggered = new Set<string>();
  private eventSeq = 0;
  private visits = 0;
  /** Initial budget plus traceable step effects; consumed in visits (D105). */
  private tripLength: number;
  /** Set by a turn during this visit; consumed when the next hop is chosen. */
  private turnPending = false;

  constructor(
    private readonly board: CompiledBoard,
    private readonly settlement: Settlement,
    private readonly services: RunServices,
  ) {
    validateBoard(board);
    this.tripLength = resolveVisitBudget(board, settlement);
    for (const card of board.cards) {
      const state = stateOf(card, settlement.cardStates);
      if (!Number.isSafeInteger(state.stock) || state.stock < 0 || (card.usage && state.stock > card.usage.maxStock))
        throw new Error(`invalid initial card state: ${card.id}`);
    }
    this.accounts = new AccountStore(accountDefsOf(board), settlement.carriedAccounts, settlement.round);
    for (const [ch, v] of Object.entries(board.startPayload)) this.accounts.deposit(SHUTTLE_ACCOUNT, ch, v);
  }

  execute(): RunResult {
    this.depart();
    let cellId = this.board.start.cell;
    let entryPort = this.board.start.entryPort;
    // A trip of zero cells is legal: nothing is visited and the (departed) payload is the result.
    if (this.tripLength === 0) return this.finish();
    for (;;) {
      if (this.visits + 1 > this.board.budget.maxVisits) throw new HardBudgetExceeded(`visit budget ${this.board.budget.maxVisits} exceeded`);
      const cell = this.cell(cellId);
      const ordinal = (this.visitOrdinals.get(cellId) ?? 0) + 1;
      this.visitOrdinals.set(cellId, ordinal);
      this.visits += 1;
      const visit: Visit = { id: `${cellId}#${ordinal}`, cell, entryPort, ordinal };
      this.turnPending = false;
      this.push({ eventType: 'visit', visitId: visit.id, cellId, entryPort, status: 'info' });

      const view = adjacencyViewFor(this.board, cellId, this.settlement.layout.placements);
      // Cell-owned modifiers (resonance) are active only while the shuttle is on that cell, and only
      // when it came in by their entry port.
      const active: ActiveModifier[] = [];
      for (const e of cell.effects) {
        if (e.event !== 'modifyOperation' || !e.modifier) continue;
        if (e.entryPort && e.entryPort !== visit.entryPort) { this.portMismatch(visit, e); continue; }
        active.push({ source: e.owner, def: e.modifier });
      }

      this.runEffects(visit, cell.effects.filter((e) => e.event === 'beforeCard'), active, view);
      this.runEffects(visit, cell.effects.filter((e) => e.event === 'onVisit'), active, view);
      const cardId = this.settlement.layout.placements[cellId];
      if (cardId && this.board.cards.some((c) => c.id === cardId)) this.runCard(visit, cardId, active, view);
      this.runEffects(visit, cell.effects.filter((e) => e.event === 'afterCard'), active, view);

      // The trip is counted in visits, so the last cell is settled where it stands (D89).
      if (this.visits >= this.tripLength) {
        this.runEffects(visit, cell.effects.filter((e) => e.event === 'onExit'), active, view);
        this.visitComplete(visit);
        return this.finish();
      }

      const exit = this.selectExit(visit);
      if (exit.kind === 'failed') return { status: 'failed', reason: exit.reason, partialTrace: this.trace };
      const edge = exit.edge;
      this.push({ eventType: 'route', visitId: visit.id, cellId, edgeId: edge.id, status: 'info', reasonCode: exit.reasonCode, reason: exit.reason });
      this.runEffects(visit, cell.effects.filter((e) => e.event === 'onExit'), active, view);
      this.visitComplete(visit);
      this.push({ eventType: 'traverse', visitId: visit.id, edgeId: edge.id, status: 'info' });
      this.runEffects(visit, (edge.effects ?? []).filter((e) => e.event === 'onTraverse'), active, view);
      cellId = edge.to.cell;
      entryPort = edge.to.port;
    }
  }

  // ── departure ────────────────────────────────────────────────────────

  /** Weather-like cards and waiting growth bursts act once on the starting payload and trip. */
  private depart(): void {
    const runtime = this.services.cards;
    if (!runtime) return;
    const actions = runtime.depart(Object.freeze(this.shuttleSnapshot()));
    if (!actions.length) return;
    this.push({ eventType: 'departure', visitId: 'departure', status: 'info' });
    const noCell: Visit = { id: 'departure', cell: this.cell(this.board.start.cell), entryPort: this.board.start.entryPort, ordinal: 0 };
    for (const action of actions) this.applyAction(noCell, action, [], { neighbors: [] }, true);
  }

  // ── cards ────────────────────────────────────────────────────────────

  private runCard(visit: Visit, cardId: string, active: ActiveModifier[], view: AdjacencyView): void {
    const owner: OwnerRef = { kind: 'card', id: cardId };
    const runtime = this.services.cards;
    const def = this.board.cards.find((c) => c.id === cardId)!;
    if (!runtime) return;
    // A basic card with no uses left does not run.
    if (def.usage && availableUses(def, stateOf(def, this.settlement.cardStates)) <= 0) {
      this.push({ eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner, effectId: `card:${cardId}`, status: 'notTriggered', reason: 'no uses left', reasonCode: 'noUses' });
      return;
    }
    const pass = (this.cardPasses.get(cardId) ?? 0) + 1;
    this.cardPasses.set(cardId, pass);
    const store = this.storeOf(cardId);
    const out = runtime.pass({
      cardId, cellId: visit.cell.id, entryPort: visit.entryPort, pass, step: this.visits,
      shuttle: Object.freeze(this.shuttleSnapshot()),
      stored: store && this.accounts.has(store) ? this.accounts.total(store) : 0,
    });
    if (!out.actions.length) {
      this.push({ eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner, effectId: `card:${cardId}`, status: 'notTriggered',
        ...(out.error ? { reason: out.error, reasonCode: 'cardError' as const } : {}) });
      return;
    }
    if (out.triggered) this.triggered.add(cardId);
    for (const action of out.actions) this.applyAction(visit, action, active, view, false);
  }

  private applyAction(visit: Visit, action: CardAction, active: ActiveModifier[], view: AdjacencyView, departure: boolean): void {
    const owner: OwnerRef = { kind: 'card', id: action.owner };
    const deltas: Delta[] = [];
    const modifiers: ModifierRecord[] = [];
    let reason: string | undefined, reasonCode: ReasonCode | undefined, reasonArgs: ReasonArgs | undefined;
    for (const op of action.operations) {
      // A turn cannot happen before the first step: there is no way back out of the start.
      if (departure && op.op === 'turnShuttle') continue;
      const out = this.applyOperation(op, owner, active, view);
      deltas.push(...out.deltas);
      modifiers.push(...out.modifiers);
      if (out.reason) { reason = out.reason; reasonCode = out.reasonCode; reasonArgs = out.reasonArgs; }
    }
    this.push({ eventType: 'effect', visitId: visit.id, ...(departure ? {} : { cellId: visit.cell.id }), owner, effectId: `card:${action.owner}`,
      status: 'applied', deltas, modifiers, reason, reasonCode, reasonArgs, cardEffects: [...action.summary] });
  }

  private storeOf(cardId: string): string | undefined {
    return this.board.cards.find((c) => c.id === cardId)?.accounts?.[0]?.id;
  }

  // ── cell and edge effects ─────────────────────────────────────────────

  private portMismatch(visit: Visit, effect: EffectDef): void {
    this.push({ eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner: effect.owner, effectId: effect.id, status: 'notTriggered',
      reason: `entry port ${visit.entryPort} does not match ${effect.entryPort}`, reasonCode: 'entryPortMismatch', reasonArgs: { expected: effect.entryPort ?? '' } });
  }

  private runEffects(visit: Visit, effects: EffectDef[], active: ActiveModifier[], view: AdjacencyView): void {
    for (const effect of [...effects].sort((a, b) => a.order - b.order)) {
      if (effect.event === 'modifyOperation') continue;
      if (effect.entryPort && effect.entryPort !== visit.entryPort) { this.portMismatch(visit, effect); continue; }
      const deltas: Delta[] = [];
      const modifiers: ModifierRecord[] = [];
      let reason: string | undefined, reasonCode: ReasonCode | undefined, reasonArgs: ReasonArgs | undefined;
      for (const op of effect.operations) {
        const out = this.applyOperation(op, effect.owner, active, view);
        deltas.push(...out.deltas);
        modifiers.push(...out.modifiers);
        if (out.reason) { reason = out.reason; reasonCode = out.reasonCode; reasonArgs = out.reasonArgs; }
      }
      this.push({ eventType: 'effect', visitId: visit.id, cellId: visit.cell.id, owner: effect.owner, effectId: effect.id, status: 'applied', deltas, modifiers, reason, reasonCode, reasonArgs });
    }
  }

  // ── operations ───────────────────────────────────────────────────────

  private applyOperation(op: OperationDef, owner: OwnerRef, active: ActiveModifier[], view: AdjacencyView): OpOutcome {
    // An operation on an account this board does not have does nothing (it never fails the trip).
    if ((op.op === 'add' || op.op === 'scale' || op.op === 'convert') && !this.accounts.has(op.target))
      return { deltas: [], modifiers: [], status: 'notTriggered', reason: `no account ${op.target}` };
    const mod = multiplierFor(active, owner.kind, op.op, view);
    switch (op.op) {
      case 'addVisits':
      case 'scaleRemainingVisits': {
        const before = this.tripLength;
        const remaining = Math.max(0, before - this.visits);
        const delta = op.op === 'addVisits' ? op.amount : remaining * (op.factor - 1);
        const requested = before + Math.max(0, Math.floor(delta * mod.multiplier));
        // A card that buys steps can never lift the safety limit: the trip stops at it instead of failing.
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
        const amount = op.amount * mod.multiplier;
        const overflow = amount >= 0 ? this.accounts.deposit(op.target, op.channel, amount).overflow : (this.accounts.withdraw(op.target, op.channel, -amount), 0);
        return {
          deltas: [{ account: op.target, channelOrField: op.channel, before, after: this.accounts.amount(op.target, op.channel) }],
          modifiers: mod.records, status: 'applied',
          ...(overflow > 0 ? { reason: `cap reached, ${round4(overflow)} dissipated`, reasonCode: 'capReached' as const, reasonArgs: { amount: round4(overflow) } } : {}),
        };
      }
      case 'scale': {
        const before = this.accounts.amount(op.target, op.channel);
        const delta = (op.factor - 1) * before * mod.multiplier;
        if (delta >= 0) this.accounts.deposit(op.target, op.channel, delta);
        else this.accounts.withdraw(op.target, op.channel, -delta);
        return { deltas: [{ account: op.target, channelOrField: op.channel, before, after: this.accounts.amount(op.target, op.channel) }], modifiers: mod.records, status: 'applied' };
      }
      case 'convert': {
        const fromBefore = this.accounts.amount(op.target, op.from);
        const toBefore = this.accounts.amount(op.target, op.to);
        const wanted = (op.amount !== undefined ? op.amount : fromBefore * op.rate) * mod.multiplier;
        const taken = this.accounts.withdraw(op.target, op.from, wanted);
        this.accounts.deposit(op.target, op.to, taken * op.efficiency);
        return {
          deltas: [
            { account: op.target, channelOrField: op.from, before: fromBefore, after: this.accounts.amount(op.target, op.from) },
            { account: op.target, channelOrField: op.to, before: toBefore, after: this.accounts.amount(op.target, op.to) },
          ],
          modifiers: mod.records, status: 'applied',
        };
      }
      case 'transfer':
        return this.transfer(op, mod.records);
      case 'turnShuttle':
        this.turnPending = true;
        return { deltas: [], modifiers: [], status: 'applied', reason: 'the next hop leaves by the entry port', reasonCode: 'turnRequested' };
    }
  }

  private transfer(op: Extract<OperationDef, { op: 'transfer' }>, modifiers: ModifierRecord[]): OpOutcome {
    if (!this.accounts.has(op.from) || !this.accounts.has(op.to)) return { deltas: [], modifiers, status: 'notTriggered', reason: 'nothing to transfer', reasonCode: 'nothingToTransfer' };
    const available = this.accounts.amount(op.from, op.fromChannel);
    const qty = op.amount.kind === 'fixed' ? Math.min(op.amount.value, available) : available;
    if (!(qty > 0)) return { deltas: [], modifiers, status: 'notTriggered', reason: 'nothing to transfer', reasonCode: 'nothingToTransfer' };
    const toBefore = this.accounts.amount(op.to, op.toChannel);
    const gain = Number.isFinite(op.gainAsExtra) && (op.gainAsExtra ?? 0) > 0 ? op.gainAsExtra! : 0;
    const taken = this.accounts.withdraw(op.from, op.fromChannel, qty);
    const { overflow } = this.accounts.deposit(op.to, op.toChannel, taken);
    // Reward only the principal actually delivered; what did not fit goes back where it came from.
    this.accounts.deposit(op.to, op.toChannel, (taken - overflow) * gain);
    if (overflow > 0) this.accounts.deposit(op.from, op.fromChannel, overflow);
    return {
      deltas: [
        { account: op.from, channelOrField: op.fromChannel, before: available, after: this.accounts.amount(op.from, op.fromChannel) },
        { account: op.to, channelOrField: op.toChannel, before: toBefore, after: this.accounts.amount(op.to, op.toChannel) },
      ],
      modifiers, status: 'applied',
      ...(overflow > 0 ? { reason: `destination full, ${round4(overflow)} stayed at source`, reasonCode: 'destinationFull' as const, reasonArgs: { amount: round4(overflow) } } : {}),
    };
  }

  // ── routing & end ────────────────────────────────────────────────────

  /**
   * One ladder decides the port, so a turn and an endpoint can never both turn the shuttle and cancel
   * each other out (D89): ask for the natural port, let a turn swap it for the way back, and only then
   * fold if that way is closed.
   */
  private selectExit(visit: Visit): { kind: 'edge'; edge: EdgeDef; reasonCode?: ReasonCode; reason?: string } | { kind: 'failed'; reason: string } {
    const outgoing = this.board.edges.filter((e) => e.from.cell === visit.cell.id);
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
        // Turning here would walk off the board (at the start, the way in is the outside).
        port = natural;
        reasonCode = 'turnImpossibleHere';
        reason = `no edge leaves ${visit.cell.id} by the entry port, so the turn cannot happen`;
      } else {
        reasonCode = atEndpoint ? 'turnRedundantAtEndpoint' : 'turnRequested';
        reason = atEndpoint ? `turn at endpoint ${visit.cell.id} repeats the fold` : `a card turns the shuttle at ${visit.cell.id}`;
      }
    } else if (atEndpoint) {
      port = back;
      reasonCode = 'foldedAtEndpoint';
      reason = `endpoint ${visit.cell.id}: the shuttle turns around`;
    }
    const candidates = outgoing.filter((e) => e.from.port === port);
    if (candidates.length === 1) return { kind: 'edge', edge: candidates[0], reasonCode, reason };
    return { kind: 'failed', reason: candidates.length ? `ambiguous exits at ${visit.cell.id}` : `dead end at ${visit.cell.id}` };
  }

  private visitComplete(visit: Visit): void {
    this.push({ eventType: 'visitComplete', visitId: visit.id, cellId: visit.cell.id, status: 'info' });
  }

  private finish(): RunDone {
    this.push({ eventType: 'end', visitId: 'end', status: 'info', reason: 'visitBudget' });
    // Report every declared channel, including those that ended at zero.
    const shuttle: Record<ChannelId, number> = {};
    for (const c of this.board.channels) shuttle[c.id] = 0;
    Object.assign(shuttle, this.accounts.byChannel(SHUTTLE_ACCOUNT));
    const labels = new Map<string, LocalizedLabel>();
    for (const c of this.board.cells) for (const e of c.effects) labels.set(e.id, e.label);
    for (const e of this.board.edges) for (const x of e.effects ?? []) labels.set(x.id, x.label);
    for (const c of this.board.cards) labels.set(`card:${c.id}`, c.label);
    const labelOf = (id: string): LocalizedLabel => labels.get(id) ?? { zh: id, en: id };
    return {
      status: 'done',
      settlementId: this.settlement.id,
      finalState: { shuttle, net: this.net(), accounts: this.accounts.summary() },
      vectorPacket: buildVectorPacket(this.settlement.id, shuttle, this.board.dimensions, this.board.channels, this.settlement.options.readout, this.trace, SHUTTLE_ACCOUNT, labelOf),
      pendingCardStates: settleCards(this.board.cards, this.settlement.cardStates ?? {}, this.triggered),
      pendingAccounts: this.accounts.snapshotAcrossRounds(),
      trace: this.trace,
      visitBudget: this.tripLength,
      visitCounts: Object.fromEntries(this.visitOrdinals),
      visits: this.visits,
      triggeredCards: [...this.triggered],
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private net() {
    return netVector(this.accounts.byChannel(SHUTTLE_ACCOUNT), this.board.dimensions, this.board.channels);
  }

  private shuttleSnapshot(): Record<ChannelId, number> {
    const out: Record<ChannelId, number> = {};
    for (const channel of this.board.channels) out[channel.id] = this.accounts.amount(SHUTTLE_ACCOUNT, channel.id);
    return out;
  }

  private cell(id: string): CellDef {
    const c = this.board.cells.find((x) => x.id === id);
    if (!c) throw new Error(`unknown cell ${id}`);
    return c;
  }

  private push(e: Omit<TraceEvent, 'eventId' | 'netAfter' | 'deltas' | 'modifiers'> & { eventType: TraceEventType; deltas?: Delta[]; modifiers?: ModifierRecord[] }): void {
    this.eventSeq += 1;
    // Execution guard (maxEvents) is a hard limit, never a gameplay rule.
    if (this.eventSeq > this.board.budget.maxEvents) throw new HardBudgetExceeded(`event budget ${this.board.budget.maxEvents} exceeded`);
    this.trace.push({ ...e, eventId: this.eventSeq, deltas: e.deltas ?? [], modifiers: e.modifiers ?? [], netAfter: this.net() });
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
