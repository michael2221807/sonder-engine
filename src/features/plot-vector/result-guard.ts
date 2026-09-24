import type { AccountSnapshot, Layout, ScriptAcceptanceInput, VectorPacket } from '../../engine/plot-vector/core/types';
import { scriptStoreAccountId } from '../../engine/plot-vector/core/runner';
import { DIMENSION_SCHEMA_VERSION, REPRESENTATION_VERSION } from '../../engine/plot-vector/core/readout';
import { C_BUFFER_ACCOUNT } from './default-board';
import { GENESIS_CATALOG } from './genesis/catalog';
import { DEFAULT_SCRIPT_LIMITS, programHash } from './genesis/script-runtime';
import { stable, toRuntimeCandidate, type BoundCard } from './genesis/post-save';
import { narrativePromptFor, VECTOR_RUN_OPTIONS, vectorBaseBoard, type PreparedVector, type VectorOperation, type VectorResult, type VectorState } from './runtime';
import { projectNativeInput, type NativeInput } from './native-input';

/**
 * Host-side boundary for everything the sandboxed Worker sends back. The Worker runs card
 * code; its output is data, never trusted. One boundary serves the main round (aga-adapter),
 * the board preview (board-access) and ability binding: `prepare` before its prompt is
 * injected, `accept` before the state is saved, `validate` before a card is bound.
 *
 * Checks are semantic per operation and field: request identity, layout and card ownership,
 * structural budgets, legal channels, finite numbers, non-negative account balances. Every
 * rule comes from the host's own request and the shared run configuration in runtime.ts
 * (board, budget, readout, narrative strength), never from values the Worker reports about
 * itself; the injected prompt must equal the one the host derives from the checked packet.
 * Signed readouts (vector dimensions, deltas, script state values) stay signed; per-script
 * `maxAbsNumber` is not applied to aggregates. Accumulated logs are checked as "previous
 * prefix unchanged + exactly this settlement's entries", so long saves are never refused.
 */
export class VectorResultError extends Error {
  constructor(public readonly kind: VectorOperation['kind'], detail: string) {
    super(`剧情动能计算结果无效（${kind}）：${detail}`);
    this.name = 'VectorResultError';
  }
}

interface Executor { execute<T extends VectorResult>(op: VectorOperation): Promise<T>; cancelAll(): void }

/** Wraps any executor (real Worker client or a test double) so every result crosses the same boundary. */
export function guardedExecutor(inner: Executor): Executor {
  return {
    async execute<T extends VectorResult>(op: VectorOperation): Promise<T> {
      const result = await inner.execute<T>(op);
      return await assertVectorResult(op, result) as T;
    },
    cancelAll: () => inner.cancelAll(),
  };
}

export async function assertVectorResult(op: VectorOperation, result: unknown): Promise<VectorResult> {
  const fail = (detail: string): never => { throw new VectorResultError(op.kind, detail); };
  if (!isRecord(result)) throw new VectorResultError(op.kind, 'not an object');
  switch (op.kind) {
    case 'validate': return checkBound(op, result, fail);
    case 'prepare': return checkPrepared(op, result, fail);
    case 'accept': return checkAccepted(op, result, fail);
  }
}

const HASH = /^[0-9a-f]{64}$/;
const STATE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MAX_PROGRESS_ROWS = 32;
const MAX_REASON_CHARS = 2_000;
const MAX_SOURCE_SUMMARY = 3;

/** Trusted rules for one prepared round, derived from the shared configuration, not the result. */
function trustedRules() {
  const base = vectorBaseBoard();
  const readout = VECTOR_RUN_OPTIONS.readout;
  return {
    cells: base.cells.map(cell => cell.id),
    budget: base.budget,
    dimensions: base.dimensions,
    readoutVersion: `${readout.kind}-kappa${readout.kappa}`,
  };
}

async function checkBound(op: Extract<VectorOperation, { kind: 'validate' }>, r: Record<string, unknown>, fail: (d: string) => never): Promise<BoundCard> {
  if (stable(r.task) !== stable(op.task)) fail('task identity changed');
  if (r.attempts !== op.attempts) fail('attempt count changed');
  // The runtime candidate is a pure projection of the request; the host recomputes it.
  const expected = toRuntimeCandidate(op.task, op.output);
  if (stable(r.candidate) !== stable(expected)) fail('candidate differs from the requested output');
  const ref = r.ref;
  if (!isRecord(ref) || typeof ref.hash !== 'string' || !HASH.test(ref.hash)) fail('program hash malformed');
  if (ref.id !== `plot-card-${ref.hash.slice(0, 12)}`) fail('program id does not match its hash');
  if (ref.hash !== await programHash(expected)) fail('program hash does not match the candidate');
  return r as unknown as BoundCard;
}

function checkPrepared(op: Extract<VectorOperation, { kind: 'prepare' }>, r: Record<string, unknown>, fail: (d: string) => never): PreparedVector {
  if (r.id !== op.id) fail('request identity changed');
  const known = knownCards(op.state.cards);
  const rules = trustedRules();
  const board = r.board;
  if (!isRecord(board) || !Array.isArray(board.cells) || !Array.isArray(board.cards)) fail('board malformed');
  if (stable(board.cells.map(cell => (isRecord(cell) ? cell.id : null))) !== stable(rules.cells)) fail('board cells differ from the shared board');
  if (stable(board.budget) !== stable(rules.budget)) fail('board budget differs from the shared board');
  const budget = rules.budget;
  for (const card of board.cards) {
    if (!isRecord(card) || typeof card.id !== 'string' || !known.ids.has(card.id)) fail('board carries an unknown card');
  }
  checkLayout(r.layout, known.ids, rules.cells, fail);
  // The starting payload and trip are the host's own request (or its documented default).
  const starting: NativeInput = op.native ?? projectNativeInput(undefined);
  if (stable(r.starting) !== stable(starting)) fail('starting input differs from the request');
  const result = r.result;
  if (!isRecord(result) || result.status !== 'done') fail('run did not finish');
  if (result.settlementId !== op.id) fail('settlement identity changed');
  if (!Array.isArray(result.trace) || result.trace.length > budget.maxEvents) fail('trace exceeds the event budget');
  if (!safeInt(result.visits, 0) || result.visits > budget.maxVisits) fail('visit count outside the budget');
  if (!safeInt(result.visitBudget, 0) || result.visitBudget > budget.maxVisits) fail('visit budget outside the guard');
  checkPacket(result.vectorPacket, op.id, rules, fail);
  checkFinalState(result.finalState, fail);
  checkAccounts(result.pendingAccounts, known, fail);
  if (result.pendingScriptAcceptances !== undefined) {
    if (!Array.isArray(result.pendingScriptAcceptances)) fail('pending acceptances malformed');
    for (const input of result.pendingScriptAcceptances) {
      if (!isRecord(input) || typeof input.cardId !== 'string' || !known.ids.has(input.cardId)) fail('acceptance for an unknown card');
      if (!isRecord(input.ref) || known.hashes.get(input.cardId) !== input.ref.hash) fail('acceptance program does not belong to its card');
      checkScriptState(input.runState, fail); checkScriptState(input.persistentState, fail);
    }
  }
  // The injected text is derived on the host from the checked packet; a Worker cannot choose it.
  if (r.prompt !== narrativePromptFor(starting, r.layout, result.vectorPacket as unknown as VectorPacket)) {
    fail('prompt does not match the checked vector packet');
  }
  checkProgress(r.progress, known.ids, fail);
  return r as unknown as PreparedVector;
}

function checkAccepted(op: Extract<VectorOperation, { kind: 'accept' }>, r: Record<string, unknown>, fail: (d: string) => never): VectorState {
  const settlementId = op.prepared.result.settlementId;
  if (op.state.session.committed.includes(settlementId)) {
    if (stable(r) !== stable(op.state)) fail('a repeated commit must return the state unchanged');
    return r as unknown as VectorState;
  }
  if (r.version !== 1) fail('state version');
  if (stable(r.cards) !== stable(op.state.cards)) fail('accept changed the bound cards');
  if (stable(r.tasks) !== stable(op.state.tasks)) fail('accept changed the generation tasks');
  if (stable(r.layout) !== stable(op.prepared.layout)) fail('accept changed the layout');
  const known = knownCards(op.state.cards);
  const session = r.session;
  if (!isRecord(session)) fail('session malformed');
  if (session.round !== op.state.session.round + 1) fail('round did not advance by one');
  if (!Array.isArray(session.committed) || stable(session.committed) !== stable([...op.state.session.committed, settlementId])) fail('committed ids changed');
  checkAccounts(session.carriedAccounts, known, fail);
  for (const field of ['talentCharges', 'itemUses', 'resources'] as const) {
    const value = session[field];
    if (!isRecord(value) || !Object.values(value).every(n => typeof n === 'number' && Number.isFinite(n))) fail(`${field} malformed`);
  }
  if (session.scriptStates !== undefined) {
    if (!isRecord(session.scriptStates)) fail('script states malformed');
    for (const state of Object.values(session.scriptStates)) checkScriptState(state, fail);
  }
  checkCommitLog(op.state.session.scriptCommitLog ?? [], session.scriptCommitLog, settlementId,
    op.prepared.result.pendingScriptAcceptances ?? [], fail);
  const last = r.last;
  if (!isRecord(last) || last.id !== op.prepared.id) fail('last settlement identity changed');
  if (stable(last.board) !== stable(op.prepared.board) || stable(last.result) !== stable(op.prepared.result) || stable(last.layout) !== stable(op.prepared.layout)) fail('accept changed the prepared run');
  checkProgress(last.progress, known.ids, fail);
  return r as unknown as VectorState;
}

function knownCards(cards: BoundCard[]): { ids: Set<string>; hashes: Map<string, string>; accounts: Set<string> } {
  const ids = new Set<string>(), hashes = new Map<string, string>(), accounts = new Set<string>([C_BUFFER_ACCOUNT]);
  for (const card of cards) {
    ids.add(card.task.entry.id); hashes.set(card.task.entry.id, card.ref.hash);
    accounts.add(scriptStoreAccountId(card.task.entry.id, card.ref));
  }
  return { ids, hashes, accounts };
}

function checkLayout(layout: unknown, ids: Set<string>, cells: readonly string[], fail: (d: string) => never): asserts layout is Layout {
  if (!isRecord(layout) || !isRecord(layout.placements) || !Array.isArray(layout.tray)) fail('layout malformed');
  const keys = Object.keys(layout.placements);
  if (keys.length !== cells.length || cells.some(cell => !keys.includes(cell))) fail('layout cells');
  const used = new Set<string>();
  for (const value of Object.values(layout.placements)) {
    if (value === null) continue;
    if (typeof value !== 'string' || !ids.has(value) || used.has(value)) fail('layout places an unknown or duplicated card');
    used.add(value);
  }
  for (const value of layout.tray) {
    if (typeof value !== 'string' || !ids.has(value) || used.has(value)) fail('tray holds an unknown or duplicated card');
    used.add(value);
  }
}

/** Readout contract (core/readout.ts): exactly the shared board's axes, each normalized to [-1, 1];
 * unipolar axes are never negative; composition shares and intensity lie in [0, 1]. */
function checkPacket(packet: unknown, id: string, rules: ReturnType<typeof trustedRules>, fail: (d: string) => never): void {
  if (!isRecord(packet) || packet.settlementId !== id || !isRecord(packet.dimensions)) fail('vector packet malformed');
  if (packet.dimensionSchemaVersion !== DIMENSION_SCHEMA_VERSION || packet.representationVersion !== REPRESENTATION_VERSION
    || packet.readoutVersion !== rules.readoutVersion) fail('vector packet version differs from the shared readout');
  const dims = packet.dimensions;
  if (stable(Object.keys(dims).sort()) !== stable(rules.dimensions.map(d => d.id).sort())) fail('vector packet axes differ from the shared board');
  for (const d of rules.dimensions) {
    const value = dims[d.id];
    if (!finite(value) || Math.abs(value) > 1) fail(`vector dimension ${d.id} is not finite or outside [-1, 1]`);
    if (d.polarity === 'unipolar' && (value as number) < 0) fail(`vector dimension ${d.id} is unipolar but negative`);
  }
  if (packet.optionalComposition !== undefined && (!isRecord(packet.optionalComposition)
    || !Object.values(packet.optionalComposition).every(v => finite(v) && v >= 0 && v <= 1))) fail('composition outside [0, 1]');
  if (packet.optionalIntensity !== undefined
    && !(finite(packet.optionalIntensity) && packet.optionalIntensity >= 0 && packet.optionalIntensity <= 1)) fail('intensity outside [0, 1]');
  if (packet.optionalConflict !== undefined) {
    if (!isRecord(packet.optionalConflict)) fail('conflict readout malformed');
    for (const [axis, readout] of Object.entries(packet.optionalConflict)) {
      if (!rules.dimensions.some(d => d.id === axis && d.polarity === 'bipolar')) fail('conflict readout for a non-bipolar axis');
      if (!isRecord(readout) || !Object.values(readout).every(finite)) fail('conflict readout not finite');
    }
  }
  if (!Array.isArray(packet.sourceSummary) || packet.sourceSummary.length > MAX_SOURCE_SUMMARY
    || !packet.sourceSummary.every(s => isRecord(s) && nonNegative(s.magnitude))) fail('source summary malformed');
}

/** Previous entries unchanged, then exactly one entry per acceptance of this settlement, in order. */
function checkCommitLog(before: readonly unknown[], after: unknown, settlementId: string,
  pending: readonly ScriptAcceptanceInput[], fail: (d: string) => never): void {
  if (after === undefined && before.length === 0 && pending.length === 0) return;
  if (!Array.isArray(after)) fail('commit log malformed');
  const log = after as unknown[];
  if (log.length !== before.length + pending.length) fail('commit log must grow by exactly this settlement');
  if (stable(log.slice(0, before.length)) !== stable(before)) fail('commit log history changed');
  pending.forEach((input, index) => {
    const entry = log[before.length + index];
    if (!isRecord(entry) || entry.settlementId !== settlementId || entry.cardId !== input.cardId || entry.programHash !== input.ref.hash
      || (entry.status !== 'applied' && entry.status !== 'failed')
      || (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > MAX_REASON_CHARS))) {
      fail('commit log entry does not match this settlement');
    }
  });
}

function checkFinalState(state: unknown, fail: (d: string) => never): void {
  if (!isRecord(state) || !isRecord(state.shuttle) || !isRecord(state.accounts)) fail('final state malformed');
  for (const [channel, value] of Object.entries(state.shuttle)) {
    if (!GENESIS_CATALOG.channels.includes(channel) || !nonNegative(value)) fail('shuttle balance negative or not finite');
  }
  for (const account of Object.values(state.accounts)) {
    if (!isRecord(account) || !nonNegative(account.total) || !isRecord(account.byChannel) || !Object.values(account.byChannel).every(nonNegative)) fail('account balance negative or not finite');
  }
}

function checkAccounts(snapshot: unknown, known: ReturnType<typeof knownCards>, fail: (d: string) => never): asserts snapshot is AccountSnapshot {
  if (!isRecord(snapshot)) fail('account snapshot malformed');
  for (const [account, entries] of Object.entries(snapshot)) {
    if (!known.accounts.has(account)) fail(`unknown account ${account}`);
    if (!Array.isArray(entries)) fail('account entries malformed');
    for (const entry of entries) {
      if (!isRecord(entry) || !safeInt(entry.round, 0) || !isRecord(entry.amounts)) fail('account entry malformed');
      for (const [channel, amount] of Object.entries(entry.amounts)) {
        if (!GENESIS_CATALOG.channels.includes(channel) || !nonNegative(amount)) fail('account amount negative, not finite or off-catalog');
      }
    }
  }
}

function checkScriptState(state: unknown, fail: (d: string) => never): void {
  if (!isRecord(state)) fail('script state malformed');
  const keys = Object.keys(state);
  if (keys.length > DEFAULT_SCRIPT_LIMITS.maxStateKeys) fail('script state has too many keys');
  for (const [key, value] of Object.entries(state)) {
    if (!STATE_KEY.test(key)) fail('script state key malformed');
    if (typeof value === 'boolean') continue;
    if (!finite(value) || Math.abs(value) > DEFAULT_SCRIPT_LIMITS.maxAbsNumber) fail('script state value outside its bound');
  }
}

function checkProgress(progress: unknown, ids: Set<string>, fail: (d: string) => never): void {
  if (progress === undefined) return;
  if (!Array.isArray(progress)) fail('progress malformed');
  for (const card of progress) {
    if (!isRecord(card) || typeof card.cardId !== 'string' || !ids.has(card.cardId) || typeof card.name !== 'string') fail('progress for an unknown card');
    if (!Array.isArray(card.rows) || card.rows.length > MAX_PROGRESS_ROWS) fail('progress rows malformed');
    for (const row of card.rows) {
      if (!isRecord(row) || typeof row.key !== 'string' || typeof row.label !== 'string' || !finite(row.value)) fail('progress row malformed');
      if (row.max !== undefined && !finite(row.max)) fail('progress max malformed');
      if (row.delta !== undefined && !finite(row.delta)) fail('progress delta malformed');
      if (row.channel !== undefined && typeof row.channel !== 'string') fail('progress channel malformed');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nonNegative(value: unknown): value is number { return finite(value) && value >= 0; }
function safeInt(value: unknown, min: number): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
