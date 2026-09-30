/**
 * What the card table shows (rebuild plan phase 7; PO 2026-09-27 1A 2A 4A, demo docs/demo/plot-vector-board.html):
 * the board's cells, the hand, each card's face and corner marks, the weather, entries whose ability is still
 * forming, and a trip read as steps for the shuttle animation. Pure: the UI supplies the words.
 */
import { SHUTTLE_ACCOUNT } from '../../engine/plot-vector/core/runner';
import { availableUses, stateOf } from '../../engine/plot-vector/core/card-state';
import type { CardDef, Layout, LocalizedLabel, RunDone } from '../../engine/plot-vector/core/types';
import type { BoardView } from './board-access';
import type { PreparedVector } from './runtime';
import type { CardTier } from './rating';
import type { BoardShape } from './vector-board';

export type TableCardKind = 'item' | 'talent' | 'status' | 'environment' | 'supply';
export interface TableCard {
  id: string;
  kind: TableCardKind;
  name: LocalizedLabel;
  /** The one-sentence effect. */
  line?: LocalizedLabel;
  /** The entry's own text in the story. */
  story?: LocalizedLabel;
  /** Supply cards only: drives the rarity light (PO 2A). */
  tier?: CardTier;
  uses?: { left: number; max: number };
  level?: { value: number; max?: number };
  stored?: number;
  /** A recharging supply card: progress towards its next use. */
  charge?: { progress: number; every: number; on: 'round' | 'trigger' };
  /** No use left now; a recharging card waits in the hand until it regains one. */
  resting: boolean;
}
export type CellRole = 'resonance' | 'converter' | 'effect' | 'status';
export interface TableCell { id: string; role: CellRole; card: string | null }
/** An obtained entry whose ability is not usable yet (4A: never placeable; the retry lives in its details). */
export interface FormingCard { id: string; kind: TableCardKind; name: string; failed: boolean }
export interface TableModel {
  shape: BoardShape;
  cells: TableCell[];
  /** Hand order: placeable cards not on the board, then resting ones. */
  hand: string[];
  cards: Record<string, TableCard>;
  /** Environment cards: act at departure, shown as weather above the board. */
  weather: string[];
  forming: FormingCard[];
}

const STATUS_CELL = '06';
const kindOf = (card: CardDef): TableCardKind =>
  card.origin === 'effect' ? 'status' : card.origin === 'environment' ? 'environment' : card.origin === 'supply' ? 'supply'
    : card.origin === 'talent' ? 'talent' : 'item';
const roleOf = (id: string, kind: string): CellRole =>
  id === STATUS_CELL ? 'status' : kind === 'resonance' ? 'resonance' : kind === 'converter' ? 'converter' : 'effect';

/** Every card the prepared board knows, with its face and marks. */
export function tableCards(view: BoardView, prepared: PreparedVector): Record<string, TableCard> {
  const states = view.state.session.cardStates;
  const progress = new Map((prepared.progress ?? []).map(p => [p.cardId, p.rows]));
  return Object.fromEntries(prepared.board.cards.map(def => {
    const rows = progress.get(def.id) ?? [];
    const level = rows.find(r => r.key === 'level'), stored = rows.find(r => r.key === 'stored');
    const supply = view.supply[def.id];
    const left = def.usage ? availableUses(def, stateOf(def, states)) : undefined;
    const card: TableCard = {
      id: def.id, kind: kindOf(def), name: def.label,
      ...(def.summary ? { line: def.summary } : {}),
      ...(def.originalText ? { story: def.originalText } : {}),
      ...(supply ? { tier: supply.tier } : {}),
      ...(def.usage && left !== undefined ? { uses: { left, max: def.usage.maxStock } } : {}),
      ...(level ? { level: { value: level.value, ...(level.max !== undefined ? { max: level.max } : {}) } } : {}),
      ...(stored && stored.value > 0 ? { stored: stored.value } : {}),
      ...(supply?.recharge ? { charge: { progress: supply.recharge.progress, every: supply.recharge.every, on: supply.recharge.on } } : {}),
      resting: left === 0,
    };
    return [def.id, card];
  }));
}

/**
 * The table for the player's current arrangement. `layout` is what the player sees now (their last move),
 * `prepared` the most recent computed trip; a card the player may place is one the prepared trip offered.
 */
export function tableModel(view: BoardView, prepared: PreparedVector, layout: Layout, shape: BoardShape): TableModel {
  const cards = tableCards(view, prepared);
  const offered = new Set([...prepared.layout.tray, ...Object.entries(prepared.layout.placements)
    .filter(([cell, id]) => cell !== STATUS_CELL && id).map(([, id]) => id as string)]);
  const cells: TableCell[] = prepared.board.cells.map(cell => {
    const placed = cell.id === STATUS_CELL ? prepared.layout.placements[STATUS_CELL] ?? null : layout.placements[cell.id] ?? null;
    return { id: cell.id, role: roleOf(cell.id, cell.kind), card: placed && cards[placed] ? placed : null };
  });
  const onBoard = new Set(cells.map(c => c.card).filter((id): id is string => !!id));
  const placeable = [...offered].filter(id => cards[id] && !onBoard.has(id));
  const resting = Object.values(cards).filter(c => c.kind === 'supply' && c.resting && !offered.has(c.id)).map(c => c.id);
  return {
    shape, cells, cards,
    hand: [...placeable, ...resting],
    weather: Object.values(cards).filter(c => c.kind === 'environment').map(c => c.id),
    forming: view.backlog.map(b => ({ id: b.id, kind: b.kind === 'effect' ? 'status' : b.kind === 'environment' ? 'environment' : b.kind === 'talent' ? 'talent' : 'item',
      name: b.name, failed: b.state === 'failed' })),
  };
}

/**
 * Move a card onto a cell, swapping with what was there, or back to the hand with `cell` null. Pure. Only the
 * cells matter: the round recomputes the tray from what the player holds (prepareVector).
 */
export function arrange(layout: Layout, card: string, cell: string | null): Layout {
  const placements = { ...layout.placements };
  const from = Object.keys(placements).find(key => placements[key] === card) ?? null;
  if (cell === STATUS_CELL || from === STATUS_CELL) return layout;
  if (cell === null) {
    if (from) placements[from] = null;
  } else {
    const occupant = placements[cell] ?? null;
    placements[cell] = card;
    if (from && from !== cell) placements[from] = occupant;
  }
  return { placements, tray: layout.tray };
}

/** Take every card the player placed off the board (the status cell is the engine's). */
export function sweep(layout: Layout): Layout {
  return { placements: Object.fromEntries(Object.entries(layout.placements).map(([cell, id]) => [cell, cell === STATUS_CELL ? id : null])), tray: layout.tray };
}

/** What a card did at one pass, as one sign for the animation. */
export type PassSign = 'push' | 'drag' | 'social' | 'chance' | 'route' | 'store';
export interface WalkStep { cell: string; back: boolean; acted: Array<{ card: string; sign: PassSign }> }
export interface TripWalk {
  /** Cards that acted at departure (environment, like weather). */
  departure: Array<{ card: string; sign: PassSign }>;
  steps: WalkStep[];
  /** Where the trip leaned, in [-1, 1] for S and [0, 1] for Y and J (the readout the model read). */
  tendency: { s: number; y: number; j: number };
}

function signOf(event: RunDone['trace'][number]): PassSign | null {
  if (event.cardEffects?.some(e => e.startsWith('steps') || e === 'turn')) return 'route';
  const change: Record<string, number> = {};
  let store = 0;
  for (const d of event.deltas) {
    if (d.account === SHUTTLE_ACCOUNT) change[d.channelOrField] = (change[d.channelOrField] ?? 0) + d.after - d.before;
    else store += Math.abs(d.after - d.before);
  }
  const gains: Array<[PassSign, number]> = [['push', change['S+'] ?? 0], ['social', change.Y ?? 0], ['chance', change.J ?? 0]];
  const best = gains.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (best[1] > 1e-9) return best[0];
  if ((change['S-'] ?? 0) > 1e-9) return 'drag';
  if ((change['S-'] ?? 0) < -1e-9) return 'push';
  return store > 1e-9 ? 'store' : null;
}

/** A trip as the shuttle's steps, with the cards that acted at each and the sign each left. */
export function tripWalk(result: RunDone): TripWalk {
  const steps: WalkStep[] = [], departure: TripWalk['departure'] = [];
  const byVisit = new Map<string, WalkStep>();
  for (const event of result.trace) {
    if (event.eventType === 'visit' && event.cellId) {
      const step: WalkStep = { cell: event.cellId, back: event.entryPort === 'R', acted: [] };
      steps.push(step); byVisit.set(event.visitId, step);
      continue;
    }
    if (event.eventType !== 'effect' || event.status !== 'applied' || event.owner?.kind !== 'card' || !event.cardEffects?.length) continue;
    const sign = signOf(event);
    if (!sign) continue;
    const acted = { card: event.owner.id, sign };
    if (event.visitId === 'departure') departure.push(acted);
    else byVisit.get(event.visitId)?.acted.push(acted);
  }
  const d = result.vectorPacket.dimensions;
  return { departure, steps, tendency: { s: d.S ?? 0, y: d.Y ?? 0, j: d.J ?? 0 } };
}
