import type { TraceEvent } from '../../engine/plot-vector/core/types';
import { SHUTTLE_ACCOUNT } from '../../engine/plot-vector/core/runner';
import { storeAccountId } from './contract/trip';

/** A short, observed account of one card in this specific trip, never a promise for every board. */
export interface CardTripReceipt {
  activations: number;
  shuttleChanges: Record<string, number>;
  stored: number;
  released: number;
  otherEffects: Array<'route'>;
}

/** What one card did in a trip, read from the trace (the deltas are authoritative). */
export function cardTripReceipt(trace: readonly TraceEvent[], cardId: string): CardTripReceipt {
  const shuttleChanges: Record<string, number> = {};
  const otherEffects = new Set<'route'>();
  // Passes it acted on: one pass may leave several events (an environment's adds and multipliers apart, an echo).
  const acted = new Set<string>();
  let stored = 0, released = 0;
  const store = storeAccountId(cardId);
  for (const event of trace) {
    if (event.eventType !== 'effect' || event.owner?.kind !== 'card' || event.owner.id !== cardId
      || event.status !== 'applied' || !event.cardEffects?.length) continue;
    acted.add(event.visitId);
    for (const delta of event.deltas) {
      const change = delta.after - delta.before;
      if (delta.account === SHUTTLE_ACCOUNT) shuttleChanges[delta.channelOrField] = (shuttleChanges[delta.channelOrField] ?? 0) + change;
      else if (delta.account === store) { if (change > 0) stored += change; else released -= change; }
    }
    // Steps and turns change the route, which the trace records as the trip itself.
    if (event.cardEffects.some(effect => effect.startsWith('steps') || effect === 'turn')) otherEffects.add('route');
  }
  return { activations: acted.size, shuttleChanges, stored, released, otherEffects: [...otherEffects] };
}
