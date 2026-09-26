import { buildSixCellBoard } from './default-board';
import { compileBoard } from '../../engine/plot-vector/core/policies';
import { run } from '../../engine/plot-vector/core/runner';
import { commitRun, createSession, type VectorSession } from '../../engine/plot-vector/core/session';
import { grantRoundSupplies } from '../../engine/plot-vector/core/card-state';
import type { BoardDef, CardDef, CardOrigin, CompiledBoard, Layout, RunDone, RunOptions, VectorPacket } from '../../engine/plot-vector/core/types';
import { activeSavedCards } from './saved-elements';
import type { BoundCard, GenesisTask, SavedElement } from './genesis/post-save';
import { buildNarrativeInputV2 } from './decoder/narrative-input-v2';
import { projectNativeInput, type NativeInput } from './native-input';
import { readCardProgress, readSupplyProgress, type CardProgress } from './card-progress';
import { BASIC_SUPPLY, basicSupplyCards, hasUses } from './basic-supply';
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
export interface VectorTaskRow {
  task: GenesisTask;
  status: 'pending' | 'sending' | 'failed' | 'bound';
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
  return { ...(state as VectorState), growth: Object.fromEntries(Object.entries(state.growth ?? {}).map(([id, g]) => [id, readGrowth(g)])) };
}

/** The single board, run options and narrative strength every AGA vector round uses. */
export const VECTOR_RUN_OPTIONS: RunOptions = { readout: { kind: 'N1', kappa: 10 } };
export const VECTOR_NARRATIVE_STRENGTH = 0.25;
export function vectorBaseBoard(): BoardDef { return buildSixCellBoard({ topology: 'line' }); }
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
  return { task, spec: { ...checked.spec, type: cardTypeOf(task.entry) } };
}

/**
 * Prepare a round's trip in the page (rebuild plan §4): the player's arrangement for 01–05, one status
 * card for the status cell, environment cards acting at departure. Throws when the trip cannot be run;
 * the caller then runs the round without momentum.
 */
export function prepareVector(state: VectorState, entries: readonly SavedElement[], id: string, native?: NativeInput): PreparedVector {
  const bound = activeSavedCards(entries, state.cards.map(card => ({ bound: card })));
  const basic = basicSupplyCards();
  const status = bound.filter(card => card.task.entry.kind === 'effect');
  const environment = bound.filter(card => card.task.entry.kind === 'environment');
  const hand = bound.filter(card => card.task.entry.kind !== 'effect' && card.task.entry.kind !== 'environment');
  // The hand: the player's own cards plus basic cards that still have uses.
  const placeable = [...hand.map(c => c.task.entry.id), ...basic.filter(c => hasUses(c, state.session.cardStates)).map(c => c.id)];
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
  const board = compileBoard({ ...vectorBaseBoard(), startPayload: starting.payload, cards: [...bound.map(cardDefOf), ...basic] });
  const tripCards: TripCard[] = [
    ...bound.map(card => ({ id: card.task.entry.id, spec: card.spec, departs: card.task.entry.kind === 'environment' })),
    ...BASIC_SUPPLY.map(card => ({ id: card.id, spec: card.spec, departs: false })),
  ];
  const cards = new TripCards(tripCards, state.growth, id);
  const result = run(board, { id, round: state.session.round, seed: id, layout, options: VECTOR_RUN_OPTIONS,
    cardStates: state.session.cardStates, carriedAccounts: state.session.carriedAccounts, visitBudget: starting.visitBudget }, { cards });
  if (result.status === 'failed') throw new Error(`剧情动能这回合算不出来（${result.reason}）`);
  const departed = environment.length > 0 || result.trace.some(e => e.eventType === 'departure');
  return { id, board, result, layout, starting, growth: cards.finalGrowth(),
    progress: [...readCardProgress(bound, { growth: state.growth, session: state.session }), ...readSupplyProgress(basic, state.session.cardStates)],
    prompt: narrativePromptFor(starting, layout, result.vectorPacket, departed) };
}

/**
 * Accept a prepared trip with its round: commit the session, top up basic supply, keep this trip's growth
 * and count round growth. Idempotent: a trip already accepted leaves the state as it is.
 */
export function acceptVector(state: VectorState, prepared: PreparedVector): VectorState {
  if (state.session.committed.includes(prepared.result.settlementId)) return state;
  const basic = basicSupplyCards();
  const committed = commitRun(state.session, prepared.board, prepared.result);
  // Basic supply is topped up once per accepted round, after this round's uses were deducted.
  const session = { ...committed, cardStates: grantRoundSupplies(basic, committed.cardStates ?? {}).states };
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
  return { ...state, session, growth, layout: prepared.layout,
    last: { id: prepared.id, board: prepared.board, result: prepared.result, layout: prepared.layout, starting: prepared.starting,
      progress: [...readCardProgress(active, { growth, session }, { growth: state.growth, session: state.session }),
        ...readSupplyProgress(basic, session.cardStates, state.session.cardStates ?? {})] } };
}
