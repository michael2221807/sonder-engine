import type { BoundCard } from './genesis/post-save';
import type { VectorSession } from '../../engine/plot-vector/core/session';
import type { CardDef, CardStates } from '../../engine/plot-vector/core/types';
import { stateOf } from '../../engine/plot-vector/core/card-state';
import { growthCap } from './contract/growth';
import { storeAccountId } from './contract/trip';
import { LIMITS, type GrowthState } from './contract/types';

/** One progress row. `key` names what it is; the UI supplies the words. */
interface CardProgressRow { key: 'level' | 'stored' | 'uses'; value: number; max?: number; delta?: number }
export interface CardProgress { cardId: string; name: string; rows: CardProgressRow[] }

/** What a round keeps for each card: its growth and its store. */
export interface ProgressSource { growth: Readonly<Record<string, GrowthState>>; session: VectorSession }

function storedIn(session: VectorSession, cardId: string): number {
  return (session.carriedAccounts[storeAccountId(cardId)] ?? []).reduce((sum, entry) =>
    sum + Object.values(entry.amounts).reduce((a, b) => a + b, 0), 0);
}

/** Growth level (for cards that grow) and store (when it holds something), with the change since `previous`. */
export function readCardProgress(cards: BoundCard[], now: ProgressSource, previous?: ProgressSource): CardProgress[] {
  return cards.map(card => {
    const id = card.task.entry.id, rows: CardProgressRow[] = [];
    if (card.spec.growth) {
      const level = now.growth[id]?.level ?? 0;
      rows.push({ key: 'level', value: level, max: growthCap(card.spec.growth), ...(previous ? { delta: level - (previous.growth[id]?.level ?? 0) } : {}) });
    }
    const stored = storedIn(now.session, id), before = previous ? storedIn(previous.session, id) : 0;
    if (stored > 0 || before > 0) rows.push({ key: 'stored', value: stored, max: LIMITS.stored, ...(previous ? { delta: stored - before } : {}) });
    return { cardId: id, name: card.spec.for, rows };
  }).filter(card => card.rows.length);
}

/** Remaining uses of the basic filler cards. */
export function readSupplyProgress(cards: CardDef[], states: CardStates | undefined, previous?: CardStates): CardProgress[] {
  return cards.filter(card => card.usage).map(card => {
    const value = stateOf(card, states).stock;
    return { cardId: card.id, name: card.label.zh, rows: [{ key: 'uses' as const, value, max: card.usage!.maxStock,
      ...(previous ? { delta: value - stateOf(card, previous).stock } : {}) }] };
  });
}
