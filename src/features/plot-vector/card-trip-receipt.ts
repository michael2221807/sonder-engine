import type { TraceEvent } from '../../engine/plot-vector/core/types';
import { SHUTTLE_ACCOUNT } from '../../engine/plot-vector/core/runner';

/** A short, observed account of one card in this specific trial, never a promise for every board. */
export interface CardTripReceipt {
  activations: number;
  shuttleChanges: Record<string, number>;
  stored: number;
  released: number;
  otherEffects: Array<'route' | 'mode'>;
}

function observedKind(source: string): 'route' | 'mode' | null {
  try {
    const effect: unknown = JSON.parse(source);
    if (!effect || typeof effect !== 'object' || !('kind' in effect)) return null;
    const kind = effect.kind;
    if (kind === 'addVisits' || kind === 'scaleRemainingVisits' || kind === 'turnShuttle') return 'route';
    if (kind === 'setMode') return 'mode';
  } catch { /* Old trace text is not an executable effect; deltas remain authoritative. */ }
  return null;
}

export function cardTripReceipt(trace: readonly TraceEvent[], cardId: string): CardTripReceipt {
  const shuttleChanges: Record<string, number> = {};
  const otherEffects = new Set<'route' | 'mode'>();
  let activations = 0, stored = 0, released = 0;
  for (const event of trace) {
    if (event.eventType !== 'effect' || event.owner?.kind !== 'card' || event.owner.id !== cardId
      || !event.programHash || !event.scriptEffects?.length) continue;
    activations++;
    for (const delta of event.deltas) {
      const change = delta.after - delta.before;
      if (delta.account === SHUTTLE_ACCOUNT) {
        shuttleChanges[delta.channelOrField] = (shuttleChanges[delta.channelOrField] ?? 0) + change;
      } else if (delta.account.startsWith('script-store:')) {
        if (change > 0) stored += change;
        else released -= change;
      }
    }
    // The trace does not expose a per-operation before/after trip length or mode.
    // Name these categories only; the final trip and visit replay carry their actual result.
    if (event.status === 'applied') for (const effect of event.scriptEffects) {
      const kind = observedKind(effect);
      if (kind) otherEffects.add(kind);
    }
  }
  return { activations, shuttleChanges, stored, released, otherEffects: [...otherEffects] };
}
