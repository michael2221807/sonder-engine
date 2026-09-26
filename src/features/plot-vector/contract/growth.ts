/**
 * The growth machine (rebuild plan §2.5, charter I11). The model only declares that a card grows, how
 * often and what grows; the engine counts, levels up, persists and feeds the level back as `ctx.level`.
 */
import { LIMITS, type GrowthSpec, type GrowthState, type GrowthTrigger } from './types';

export function initialGrowth(): GrowthState {
  return { level: 0, progress: 0, pendingBursts: 0 };
}

/** The highest level a spec can reach (declared max, never above the engine's hard limit). */
export function growthCap(spec: GrowthSpec): number {
  return Math.min(LIMITS.growthMax, Math.max(0, Math.floor(spec.max)));
}

/**
 * Count one growth event. Only events of the spec's own kind count; every `every` of them is a level,
 * up to the cap (progress stops counting at the cap). Returns the new state and the levels gained.
 */
export function grow(spec: GrowthSpec | undefined, state: GrowthState, event: GrowthTrigger): { state: GrowthState; gained: number } {
  if (!spec || spec.on !== event) return { state, gained: 0 };
  const cap = growthCap(spec);
  if (state.level >= cap) return { state: { ...state, progress: 0 }, gained: 0 };
  const every = Math.max(1, Math.floor(spec.every));
  const progress = state.progress + 1;
  if (progress < every) return { state: { ...state, progress }, gained: 0 };
  return { state: { ...state, level: state.level + 1, progress: 0 }, gained: 1 };
}

/**
 * Round growth at an accepted round (`round` for every owned card, `placedRound` for cards that were on
 * the board). Its bursts cannot fire between trips, so they wait for the next departure.
 */
export function growAtRound(spec: GrowthSpec | undefined, state: GrowthState, placed: boolean): GrowthState {
  let next = grow(spec, state, 'round');
  if (placed) {
    const placedStep = grow(spec, next.state, 'placedRound');
    next = { state: placedStep.state, gained: next.gained + placedStep.gained };
  }
  return next.gained ? { ...next.state, pendingBursts: next.state.pendingBursts + next.gained } : next.state;
}

/** Read a persisted growth record defensively (old or damaged data reads as a fresh card). */
export function readGrowth(value: unknown): GrowthState {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
  const whole = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0);
  return { level: Math.min(LIMITS.growthMax, whole(record.level)), progress: whole(record.progress), pendingBursts: Math.min(LIMITS.growthMax, whole(record.pendingBursts)) };
}
