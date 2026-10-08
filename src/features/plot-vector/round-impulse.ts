/**
 * The round's push in two words (PO 3A, charter I27): shown beside the round title, derived by the engine from
 * the same packet the model read, never written by the model. The UI turns the keys into words.
 */
import type { VectorPacket } from '../../engine/plot-vector/core/types';
import { narrativePromptFor, type VectorState } from './runtime';

/** Going well, level, some resistance, heavy resistance. */
type ImpulseTone = 'with' | 'even' | 'against' | 'hard';
/** Which of relations or openings leans more. */
type ImpulseLean = 'social' | 'chance';
export interface RoundImpulse { tone: ImpulseTone; lean?: ImpulseLean }

/**
 * Readout values are tanh(net / 10) in [-1, 1]. Below FAINT a dimension is not worth naming (the attributes
 * alone give about 0.15); at or beyond STRONG the resistance reads as heavy.
 */
export const IMPULSE_FAINT = 0.1;
export const IMPULSE_STRONG = 0.35;

export function impulseOf(packet: VectorPacket): RoundImpulse | null {
  const s = packet.dimensions.S ?? 0, y = packet.dimensions.Y ?? 0, j = packet.dimensions.J ?? 0;
  if (![s, y, j].every(Number.isFinite) || Math.max(Math.abs(s), y, j) < IMPULSE_FAINT) return null;
  const tone: ImpulseTone = s <= -IMPULSE_STRONG ? 'hard' : s <= -IMPULSE_FAINT ? 'against' : s >= IMPULSE_FAINT ? 'with' : 'even';
  const lean: ImpulseLean | undefined = Math.max(y, j) >= IMPULSE_FAINT ? (y >= j ? 'social' : 'chance') : undefined;
  return lean ? { tone, lean } : { tone };
}

/**
 * The impulse behind a story round: the last accepted trip, only when it was made for that round (its id ends
 * with the round number) and actually gave the model a push. A round played without momentum shows nothing.
 */
export function roundImpulse(state: VectorState | undefined, round: number): RoundImpulse | null {
  const last = state?.last;
  if (!last || !last.id.endsWith(`/${round}`) || !last.starting) return null;
  const departed = last.result.trace.some(e => e.eventType === 'departure');
  if (!narrativePromptFor(last.starting, last.layout, last.result.vectorPacket, departed)) return null;
  return impulseOf(last.result.vectorPacket);
}
