/**
 * The card table's small moments (phase 7 polish; PO-approved samples docs/demo/plot-vector-polish.html): waves
 * that leave a card from its own edge, sparks, a new card dealt into the hand with a ceremony that grows with its
 * tier, a card settling into a cell, growth, recharge, a card leaving, the sweep across a card the shuttle passes.
 * Motion only, on the elements given; every effect is skipped when the player prefers reduced motion.
 */
import type { CardTier } from '@/features/plot-vector/rating';
import { prefersReducedMotion } from './use-trip-walk';

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const SOFT = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

export const tierColor = (tier: CardTier | undefined): string => (tier ? `var(--tier-${tier})` : 'var(--color-sage-400)');
const TIER_RANK: Record<CardTier, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5 };
export const tierRank = (tier: CardTier | undefined): number => (tier ? TIER_RANK[tier] : -1);
/** The rarest of some tiers (for the badge's glow). */
export function topTier(tiers: Iterable<CardTier | undefined>): CardTier | undefined {
  let best: CardTier | undefined;
  for (const tier of tiers) if (tier && tierRank(tier) > tierRank(best)) best = tier;
  return best;
}

/** A light tap on a phone, where the device supports it. */
export function buzz(ms = 8): void {
  try { if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms); } catch { /* unsupported */ }
}

/** Waves that leave `card` from its own edge: an outline that grows outward and fades. */
export function edgeWaves(card: HTMLElement, color: string, count: number, spread = 20, gap = 160): void {
  if (prefersReducedMotion() || count <= 0) return;
  const radius = getComputedStyle(card).borderRadius || '11px';
  for (let i = 0; i < count; i++) {
    const wave = document.createElement('i');
    wave.setAttribute('aria-hidden', 'true');
    Object.assign(wave.style, { position: 'absolute', inset: '0', borderRadius: radius, pointerEvents: 'none', outline: `1.5px solid ${color}`,
      outlineOffset: '0px', opacity: '0', zIndex: '4' });
    card.appendChild(wave);
    wave.animate([{ outlineOffset: '0px', opacity: 0.95, boxShadow: `0 0 10px ${color}` }, { outlineOffset: `${spread}px`, opacity: 0, boxShadow: '0 0 0 transparent' }],
      { duration: 900, delay: i * gap, easing: EASE }).onfinish = () => wave.remove();
  }
}

/** Sparks thrown out from the centre of `host`. */
export function sparks(host: HTMLElement, color: string, count: number, reach = 60): void {
  if (prefersReducedMotion()) return;
  for (let i = 0; i < count; i++) {
    const spark = document.createElement('i');
    spark.setAttribute('aria-hidden', 'true');
    Object.assign(spark.style, { position: 'absolute', left: '50%', top: '50%', width: '3px', height: '3px', borderRadius: '50%', pointerEvents: 'none',
      background: color, boxShadow: `0 0 6px ${color}`, opacity: '0', zIndex: '5' });
    host.appendChild(spark);
    const a = (Math.PI * 2 * i) / count + Math.random() * 0.4, d = reach * (0.7 + Math.random() * 0.6);
    spark.animate([{ transform: 'translate(0,0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translate(${Math.cos(a) * d}px, ${Math.sin(a) * d - 30}px)`, opacity: 0 }],
      { duration: 1200 + Math.random() * 600, easing: SOFT }).onfinish = () => spark.remove();
  }
}

/** Motes rising from the bottom of `card` (legendary gold, mythic embers). */
export function motes(card: HTMLElement, tier: CardTier, count = 1): void {
  if (prefersReducedMotion()) return;
  const mythic = tier === 'mythic';
  for (let i = 0; i < count; i++) {
    const mote = document.createElement('i');
    mote.setAttribute('aria-hidden', 'true');
    Object.assign(mote.style, { position: 'absolute', bottom: '6px', left: `${10 + Math.random() * 80}%`, width: '3px', height: '3px', borderRadius: '50%',
      pointerEvents: 'none', zIndex: '4', background: mythic ? 'oklch(0.78 0.16 45)' : tierColor(tier), boxShadow: `0 0 ${mythic ? 8 : 6}px ${tierColor(tier)}` });
    card.appendChild(mote);
    mote.animate([{ transform: 'translateY(0)', opacity: 0 }, { opacity: 1, offset: 0.2 }, { transform: `translate(${(Math.random() - 0.5) * 18}px, ${-50 - Math.random() * 40}px)`, opacity: 0 }],
      { duration: 1200 + Math.random() * 700, easing: SOFT }).onfinish = () => mote.remove();
  }
}

/** A card landing in a cell: it settles from just above, then two waves leave its edge. */
export function settle(card: HTMLElement, tier: CardTier | undefined): void {
  if (prefersReducedMotion()) return;
  card.animate([{ translate: '0 -14px', scale: '1.04', boxShadow: '0 18px 32px rgba(0,0,0,.5)' }, { translate: '0 0', scale: '1' }], { duration: 380, easing: EASE });
  setTimeout(() => edgeWaves(card, tier && tier !== 'common' ? tierColor(tier) : 'var(--color-sage-400)', 2, 14, 170), 240);
}

/**
 * A new card dealt into the hand: it slides in face down from beyond the table, turns over, and the tier answers —
 * nothing for common, a sheen for fine and rare, waves from its edge and sparks from epic, the table's edge
 * lighting for legendary; a mythic first dims the table and glows red through its back before it turns.
 */
export async function dealIn(card: HTMLElement, tier: CardTier | undefined, table: HTMLElement | null, dim: HTMLElement | null, delay = 0): Promise<void> {
  if (prefersReducedMotion()) return;
  // Hidden from the start until its turn comes (cards are dealt one after another).
  if (delay > 0) await card.animate([{ opacity: 0 }, { opacity: 0 }], { duration: delay }).finished.catch(() => {});
  if (!card.isConnected) return;
  const rank = tierRank(tier), color = tierColor(tier), mythic = tier === 'mythic';
  const box = card.getBoundingClientRect(), from = table?.getBoundingClientRect();
  const dx = from ? from.right - box.left + 40 : 240;
  // The face stays hidden under a back until the card turns edge-on.
  const back = document.createElement('i');
  back.setAttribute('aria-hidden', 'true');
  Object.assign(back.style, { position: 'absolute', inset: '0', borderRadius: 'inherit', zIndex: '6', pointerEvents: 'none',
    background: 'repeating-linear-gradient(45deg, oklch(0.22 0.01 90) 0 6px, oklch(0.2 0.01 90) 6px 12px)',
    boxShadow: 'inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 22%, transparent)' });
  card.appendChild(back);
  const slide = mythic ? 720 : 520;
  if (mythic && dim) dim.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 2400, easing: SOFT });
  await card.animate([{ transform: `translate(${dx}px, -60px) rotate(8deg)`, opacity: 0 }, { transform: 'translate(0, -8px) rotate(0)', opacity: 1 }],
    { duration: slide, easing: SOFT }).finished.catch(() => {});
  if (mythic) {
    await back.animate([{ boxShadow: 'inset 0 0 0 1px transparent' }, { boxShadow: `inset 0 0 0 1px ${color}, 0 0 30px ${color}` }],
      { duration: 480, easing: SOFT, fill: 'forwards' }).finished.catch(() => {});
  }
  await card.animate([{ transform: 'translate(0, -8px) rotateY(0deg)' }, { transform: 'translate(0, -4px) rotateY(90deg)' }], { duration: 170, easing: 'ease-in' }).finished.catch(() => {});
  back.remove();
  await card.animate([{ transform: 'translate(0, -4px) rotateY(90deg)' }, { transform: 'translate(0, 0) rotateY(0deg)' }], { duration: 230, easing: EASE }).finished.catch(() => {});
  if (rank <= 0) return;
  if (rank <= 2) card.querySelector<HTMLElement>('.vcard__sheen')?.animate([{ opacity: 1, transform: 'translateX(-60%)' }, { opacity: 1, transform: 'translateX(60%)' }], { duration: 900, easing: SOFT });
  edgeWaves(card, color, rank >= 5 ? 3 : rank >= 4 ? 2 : rank >= 2 ? 1 : 0, mythic ? 28 : 20);
  if (rank >= 3) sparks(card, color, rank === 3 ? 6 : rank === 4 ? 10 : 16, mythic ? 80 : 60);
  if (rank >= 4) {
    card.animate([{ boxShadow: `0 0 0 1px ${color}, 0 0 40px ${color}` }, { boxShadow: '0 2px 6px rgba(0,0,0,.35)' }], { duration: 1400, easing: SOFT });
    table?.animate([{ boxShadow: 'var(--glass-shadow)' }, { boxShadow: `var(--glass-shadow), inset 0 0 0 1px color-mix(in oklch, ${color} 55%, transparent), inset 0 0 60px color-mix(in oklch, ${color} 14%, transparent)` }, { boxShadow: 'var(--glass-shadow)' }],
      { duration: mythic ? 1800 : 1400, easing: SOFT });
  }
}

/** The newest growth diamond on a card pops in, with a small ring. */
export function levelUp(card: HTMLElement): void {
  if (prefersReducedMotion()) return;
  const diamonds = card.querySelectorAll<HTMLElement>('.vcard__level');
  const last = diamonds[diamonds.length - 1];
  if (!last) return;
  last.animate([{ transform: 'rotate(45deg) scale(0)', opacity: 0 }, { transform: 'rotate(45deg) scale(1.5)', opacity: 1, offset: 0.6 }, { transform: 'rotate(45deg) scale(0.85)' }],
    { duration: 560, delay: 200, easing: EASE });
  const ring = document.createElement('i');
  ring.setAttribute('aria-hidden', 'true');
  const c = last.getBoundingClientRect(), b = card.getBoundingClientRect();
  Object.assign(ring.style, { position: 'absolute', width: '10px', height: '10px', borderRadius: '50%', pointerEvents: 'none', zIndex: '5',
    boxShadow: '0 0 0 1px var(--color-amber-300)', left: `${c.left - b.left + c.width / 2 - 5}px`, top: `${c.top - b.top + c.height / 2 - 5}px` });
  card.appendChild(ring);
  ring.animate([{ transform: 'scale(1)', opacity: 0.9 }, { transform: 'scale(4)', opacity: 0 }], { duration: 650, delay: 380, easing: EASE }).onfinish = () => ring.remove();
}

/** A card that has just regained a use glows once. */
export function chargeFull(card: HTMLElement): void {
  if (prefersReducedMotion()) return;
  card.animate([{ boxShadow: '0 2px 6px rgba(0,0,0,.35)' }, { boxShadow: '0 0 0 1px var(--color-sage-400), 0 0 22px color-mix(in oklch, var(--color-sage-400) 45%, transparent)' }, { boxShadow: '0 2px 6px rgba(0,0,0,.35)' }],
    { duration: 1000, delay: 250, easing: SOFT });
}

/** A card that left (used up): it fades and drifts away as a few motes. Resolves when it is gone. */
export async function dissolve(card: HTMLElement): Promise<void> {
  if (prefersReducedMotion()) return;
  const host = card.parentElement;
  const b = host?.getBoundingClientRect(), r = card.getBoundingClientRect();
  if (host && b) for (let i = 0; i < 10; i++) {
    const s = document.createElement('i');
    s.setAttribute('aria-hidden', 'true');
    Object.assign(s.style, { position: 'absolute', width: '3px', height: '3px', borderRadius: '50%', pointerEvents: 'none', zIndex: '5',
      background: 'var(--color-sage-300)', boxShadow: '0 0 6px var(--color-sage-400)',
      left: `${r.left - b.left + host.scrollLeft + 16 + Math.random() * (r.width - 32)}px`, top: `${r.top - b.top + 20 + Math.random() * (r.height - 30)}px` });
    host.appendChild(s);
    s.animate([{ transform: 'translate(0,0)', opacity: 0 }, { opacity: 0.9, offset: 0.25 }, { transform: `translate(${(Math.random() - 0.5) * 30}px, ${-40 - Math.random() * 40}px)`, opacity: 0 }],
      { duration: 1100 + Math.random() * 500, delay: 350 + Math.random() * 200, easing: SOFT }).onfinish = () => s.remove();
  }
  await card.animate([{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(3px)' }], { duration: 650, delay: 250, easing: SOFT, fill: 'forwards' }).finished.catch(() => {});
}

/** A warm light sweeping across a card the shuttle passes, in the shuttle's direction. */
export function sweepAcross(card: HTMLElement, back: boolean): void {
  if (prefersReducedMotion()) return;
  const clip = card.querySelector<HTMLElement>('.vcard__clip') ?? card;
  const sweep = document.createElement('i');
  sweep.setAttribute('aria-hidden', 'true');
  Object.assign(sweep.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3',
    background: 'linear-gradient(90deg, transparent, color-mix(in oklch, var(--color-amber-300) 28%, transparent), transparent)' });
  clip.appendChild(sweep);
  sweep.animate([{ transform: `translateX(${back ? 100 : -100}%)`, opacity: 1 }, { transform: `translateX(${back ? -100 : 100}%)`, opacity: 0 }],
    { duration: 420, easing: SOFT }).onfinish = () => sweep.remove();
}
