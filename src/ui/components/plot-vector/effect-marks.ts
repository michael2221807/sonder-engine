// App doc: docs/user-guide/pages/game-main.md §3.18.7 · Marks and colours
/**
 * The one vocabulary of marks the table speaks (PO 2026-10-01): card faces, the detail bubbles, the "?" legend,
 * the shuttle's floating signs, the three tendency bars and the round opening wear the same glyph and colour for
 * the same thing. ↑ leans the trip toward 顺, ↓ toward 逆, ◇ feeds relations, ✦ chances; ↻ changes the route,
 * ▣ keeps something for later. The colours are the channel tokens in tokens.css.
 */
import type { EffectMark } from '@/features/plot-vector/card-describe';
import type { ChannelName } from '@/features/plot-vector/contract/types';
import type { PassSign } from '@/features/plot-vector/table-model';

export const MARK_GLYPH: Readonly<Record<EffectMark, string>> = { up: '↑', down: '↓', social: '◇', chance: '✦', route: '↻', store: '▣' };
export const MARK_COLOR: Readonly<Record<EffectMark, string>> = {
  up: 'var(--ch-push)', down: 'var(--ch-drag)', social: 'var(--ch-social)', chance: 'var(--ch-chance)',
  route: 'var(--color-text-secondary)', store: 'var(--color-text-secondary)',
};
/** A quantity by the mark of the way it moves the bars when it rises (drag rising leans toward 逆). */
export const CHANNEL_MARK: Readonly<Record<ChannelName, EffectMark>> = { push: 'up', drag: 'down', social: 'social', chance: 'chance' };
/** What one pass did, as the shuttle's floating sign (table-model `signOf`): its mark. */
export const SIGN_MARK: Readonly<Record<PassSign, EffectMark>> = { push: 'up', drag: 'down', social: 'social', chance: 'chance', route: 'route', store: 'store' };
/** Shuttle channel ids (S+, S-, Y, J) by their quantity, and back. */
export const CHANNEL_OF_ID: Readonly<Record<string, ChannelName>> = { 'S+': 'push', 'S-': 'drag', Y: 'social', J: 'chance' };
export const ID_OF_CHANNEL: Readonly<Record<ChannelName, string>> = { push: 'S+', drag: 'S-', social: 'Y', chance: 'J' };
/** i18n key segment of each quantity's name (`mainGame.vectorTable.channel.*`). */
export const CHANNEL_KEY: Readonly<Record<ChannelName, string>> = { push: 'push', drag: 'drag', social: 'relations', chance: 'chances' };

/** A signed amount, with a true minus sign and at most two decimals. */
export function signed(value: number, locale: string): string {
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(Math.abs(value));
  return `${value < 0 ? '−' : '+'}${n}`;
}
