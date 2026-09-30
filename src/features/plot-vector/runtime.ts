import { VECTOR_RUN_OPTIONS, readBoardShape, vectorBaseBoard, type BoardShape } from './vector-board';
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import { commitRun, createSession, type VectorSession } from '../../engine/plot-vector/core/session';
import type { CardDef, CardOrigin, CompiledBoard, Layout, RunDone, VectorPacket } from '../../engine/plot-vector/core/types';
import { activeSavedCards } from './saved-elements';
import type { BoundCard, GenesisTask, SavedElement } from './genesis/post-save';
import { buildNarrativeInputV2 } from './decoder/narrative-input-v2';
import { projectNativeInput, type NativeInput } from './native-input';
import { readCardProgress, readSupplyProgress, type CardProgress } from './card-progress';
import { clampSupplyStates, initialSupply, placeableSupply, readSupplyState, settleSupply, supplyCardDefs, supplyTripCards, type SupplyRules, type SupplyState } from './supply';
import { rateCard, ratingIsCurrent, ratingPlaceOf } from './rating';
import { TripCards, storeAccount, type TripCard } from './contract/trip';
import { growAtRound, initialGrowth, readGrowth } from './contract/growth';
import { validateCard } from './contract/validate';
import type { CardType, GrowthState } from './contract/types';

/**
 * Later attempts to give a saved entry its ability after the first one failed. The first attempt's
 * `raw`/`error` on the task row are kept as they were; these fields describe only the retries.
 */
export interface AbilityRetry {
  /** Retries made so far (Step3 requests and player requests). */
  attempts: number;
  /** Rounds in which Step3 tried this entry; automatic retries stop at a fixed number of rounds. */
  autoRounds: number;
  /** Story round of the last Step3 try, so several tries within one round count once. */
  lastAutoRound?: number;
  source?: 'step3' | 'manual';
  /** Reply of the latest retry, kept before validation. */
  raw?: string;
  /** Why the latest retry did not give a usable ability. */
  error?: string;
}
/**
 * The failed ability attempts of one saved entry: the first failure's reason and reply, and the later retries.
 * Removed once the entry has a card; an entry without a card and without a row simply has not been tried.
 */
export interface VectorTaskRow {
  task: GenesisTask;
  error?: string;
  raw?: string;
  retry?: AbilityRetry;
}
export interface VectorState {
  version: 2;
  session: VectorSession;
  cards: BoundCard[];
  tasks: VectorTaskRow[];
  /** Engine-owned growth of every card, by card id (rebuild plan §2.5). */
  growth: Record<string, GrowthState>;
  /** The general supply hand (phase 6); absent in older saves, which start from the pack's opening hand. */
  supply?: SupplyState;
  /** The board shape the player chose (PO 2026-09-29); absent in older saves, which play on the line. */
  shape?: BoardShape;
  layout?: Layout;
  last?: { id: string; board: CompiledBoard; result: RunDone; layout: Layout; starting?: NativeInput; progress?: CardProgress[] };
}
export interface PreparedVector {
  id: string;
  board: CompiledBoard;
  result: RunDone;
  layout: Layout;
  prompt: string;
  starting?: NativeInput;
  progress?: CardProgress[];
  /** Growth after this trip; kept only when the round is accepted. */
  growth: Record<string, GrowthState>;
}
export function initialVectorState(): VectorState {
  return { version: 2, session: createSession(), cards: [], tasks: [], growth: {} };
}
/**
 * The stored component state. A state saved by an older version starts over: its cards and tasks used a
 * retired card format (charter I14, rebuild plan §9); the story itself is untouched.
 */
export function readVectorState(raw: unknown): VectorState {
  const state = (raw && typeof raw === 'object' ? raw : {}) as Partial<VectorState>;
  if (state.version !== 2 || !state.session || !Array.isArray(state.cards) || !Array.isArray(state.tasks)) return initialVectorState();
  // Rows only record failures; a row saved as bound by an earlier build is dropped.
  const tasks = state.tasks.filter(row => row && typeof row === 'object' && row.task?.entry && (row as { status?: unknown }).status !== 'bound');
  const supply = readSupplyState(state.supply);
  const { supply: _raw, shape: _shape, ...rest } = state as VectorState;
  return { ...rest, tasks, growth: Object.fromEntries(Object.entries(state.growth ?? {}).map(([id, g]) => [id, readGrowth(g)])),
    ...(supply ? { supply } : {}), ...(state.shape !== undefined ? { shape: readBoardShape(state.shape) } : {}) };
}

/** The narrative strength every AGA vector round uses (the board and run options live in vector-board.ts). */
export { VECTOR_RUN_OPTIONS, vectorBaseBoard };
export const VECTOR_NARRATIVE_STRENGTH = 0.25;
/** Pure: the narrative prompt a prepared round injects, derived only from its inputs and packet. */
export function narrativePromptFor(starting: NativeInput, layout: Layout, packet: VectorPacket, departed = false): string {
  const hasInput = Object.values(starting.payload).some(n => n > 0) || Object.values(layout.placements).some(Boolean) || departed;
  return hasInput ? buildNarrativeInputV2(packet, undefined, VECTOR_NARRATIVE_STRENGTH).prompt : '';
}

/** A saved entry's kind as a card type (rebuild plan §3); the entry's actual place decides it. */
export function cardTypeOf(entry: SavedElement): CardType {
  return entry.kind === 'effect' ? 'status' : entry.kind === 'talent' ? 'talent' : entry.kind === 'environment' ? 'environment' : 'item';
}
const originOf = (entry: SavedElement): CardOrigin => (entry.kind === 'other' ? 'item' : entry.kind);
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

function cardDefOf(card: BoundCard): CardDef {
  const entry = card.task.entry;
  const name = text(entry.capability.name) ?? card.spec.for;
  const description = text(entry.capability.description);
  return { id: entry.id, tags: [], source: 'Model', origin: originOf(entry), accounts: [storeAccount(entry.id)],
    label: { zh: name, en: name }, summary: { zh: card.spec.summary, en: card.spec.summary },
    ...(description ? { originalText: { zh: description, en: description } } : {}) };
}

/**
 * Bind a model-written ability to a saved entry: one check (§5). The entry's actual place decides the
 * type, whatever the model declared. Throws with the reason when the ability cannot be used.
 */
export function bindCard(task: GenesisTask, output: unknown): BoundCard {
  const checked = validateCard(output);
  if (!checked.ok) throw new Error(checked.reason);
  const spec = { ...checked.spec, type: cardTypeOf(task.entry) };
  // Every bound card is rated; the rating is recorded, not shown (PO 2A).
  return { task, spec, rating: rateCard(spec, ratingPlaceOf(spec.type)) };
}

/**
 * Prepare a round's trip in the page (rebuild plan §4): the player's arrangement for 01–05, one status
 * card for the status cell, environment cards acting at departure. Throws when the trip cannot be run;
 * the caller then runs the round without momentum.
 */
export function prepareVector(state: VectorState, entries: readonly SavedElement[], id: string, native?: NativeInput, supplyRules?: SupplyRules): PreparedVector {
  const bound = activeSavedCards(entries, state.cards.map(card => ({ bound: card })));
  const hand = supplyRules ? state.supply ?? initialSupply(supplyRules) : undefined;
  const supply = supplyRules && hand ? supplyCardDefs(supplyRules, hand) : [];
  const cardStates = supply.length ? clampSupplyStates(supply, state.session.cardStates) : state.session.cardStates;
  const status = bound.filter(card => card.task.entry.kind === 'effect');
  const environment = bound.filter(card => card.task.entry.kind === 'environment');
  const owned = bound.filter(card => card.task.entry.kind !== 'effect' && card.task.entry.kind !== 'environment');
  // The hand: the player's own cards plus supply cards that still have uses.
  const placeable = [...owned.map(c => c.task.entry.id), ...placeableSupply(supply, cardStates)];
  const seed = [...id].reduce((n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0, 0);
  const placements: Record<string, string | null> = {};
  const used = new Set<string>();
  for (let i = 1; i <= 5; i++) {
    const cell = String(i).padStart(2, '0');
    // Selection is opt-in: acquiring an ability never places or spends it automatically.
    const chosen = placeable.find(candidate => candidate === state.layout?.placements[cell] && !used.has(candidate));
    placements[cell] = chosen ?? null;
    if (chosen) used.add(chosen);
  }
  // The status cell takes at most one status card each round, chosen by the round's seed (C7).
  placements['06'] = status.length ? status[seed % status.length].task.entry.id : null;
  const layout: Layout = { placements, tray: placeable.filter(card => !used.has(card)) };
  const starting = native ?? projectNativeInput(undefined);
  const board = compileBoard({ ...vectorBaseBoard(readBoardShape(state.shape)), startPayload: starting.payload, cards: [...bound.map(cardDefOf), ...supply] });
  const tripCards: TripCard[] = [
    ...bound.map(card => ({ id: card.task.entry.id, spec: card.spec, departs: card.task.entry.kind === 'environment' })),
    ...(supplyRules && hand ? supplyTripCards(supplyRules, hand) : []),
  ];
  const cards = new TripCards(tripCards, state.growth, id);
  const result = run(board, { id, round: state.session.round, seed: id, layout, options: VECTOR_RUN_OPTIONS,
    cardStates, carriedAccounts: state.session.carriedAccounts, visitBudget: starting.visitBudget }, { cards });
  if (result.status === 'failed') throw new Error(`剧情动能这回合算不出来（${result.reason}）`);
  const departed = environment.length > 0 || result.trace.some(e => e.eventType === 'departure');
  return { id, board, result, layout, starting, growth: cards.finalGrowth(),
    progress: [...readCardProgress(bound, { growth: state.growth, session: state.session }), ...readSupplyProgress(supply, cardStates)],
    prompt: narrativePromptFor(starting, layout, result.vectorPacket, departed) };
}

/** Unrated older cards rated per accepted round (a rating takes about 40 ms: both board shapes). */
export const RATE_PER_ROUND = 4;
/**
 * Accept a prepared trip with its round: commit the session (uses are deducted), settle the supply hand
 * (recharge, exhausted cards leave, draw while there is room), keep this trip's growth and count round growth,
 * and rate any card saved before ratings existed. Idempotent: a trip already accepted leaves the state as it is.
 */
export function acceptVector(state: VectorState, prepared: PreparedVector, supplyRules?: SupplyRules): VectorState {
  if (state.session.committed.includes(prepared.result.settlementId)) return state;
  const committed = commitRun(state.session, prepared.board, prepared.result);
  const handBefore = supplyRules ? state.supply ?? initialSupply(supplyRules) : undefined;
  const settled = supplyRules && handBefore
    ? settleSupply(supplyRules, handBefore, committed.cardStates ?? {}, prepared.result, prepared.result.settlementId) : undefined;
  const session = { ...committed, cardStates: settled?.states ?? committed.cardStates };
  const supplyBefore = supplyRules && handBefore ? supplyCardDefs(supplyRules, handBefore) : [];
  const supplyAfter = supplyRules && settled ? supplyCardDefs(supplyRules, settled.supply) : [];
  const onBoard = new Set(prepared.board.cards.map(card => card.id));
  const placed = new Set(Object.values(prepared.layout.placements).filter((id): id is string => !!id));
  const growth: Record<string, GrowthState> = { ...state.growth, ...prepared.growth };
  for (const card of state.cards) {
    const id = card.task.entry.id;
    if (!onBoard.has(id)) continue;
    // Environment cards take part at departure, so they count as on the board.
    growth[id] = growAtRound(card.spec.growth, growth[id] ?? initialGrowth(), placed.has(id) || card.task.entry.kind === 'environment');
  }
  const active = state.cards.filter(card => onBoard.has(card.task.entry.id));
  // Cards saved before ratings existed, or rated by an older method, are rated a few per round, so an old save
  // never stalls one round on it.
  let toRate = RATE_PER_ROUND;
  const cards = state.cards.map(card => (ratingIsCurrent(card.rating) || toRate-- <= 0 ? card
    : { ...card, rating: rateCard(card.spec, ratingPlaceOf(card.spec.type)) }));
  const previousUses = state.session.cardStates ?? {};
  return { ...state, cards, session, growth, layout: prepared.layout, ...(settled ? { supply: settled.supply } : {}),
    last: { id: prepared.id, board: prepared.board, result: prepared.result, layout: prepared.layout, starting: prepared.starting,
      progress: [...readCardProgress(active, { growth, session }, { growth: state.growth, session: state.session }),
        ...readSupplyProgress(supplyAfter.filter(def => supplyBefore.some(b => b.id === def.id)), session.cardStates, previousUses)] } };
}
