<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.4 · Plot-vector card table
/**
 * One card's face (phase 7): the name and one sentence; everything else is a mark, never a number (PO 2A) —
 * dots for uses left, diamonds for growth, a ring for recharge. The tier (PO 2026-09-30: six, white to red) is a
 * light along the top edge, and the rarer the card the richer it feels: fine and rare cards catch a sheen on
 * hover; from epic up the card tilts toward the pointer with a light that follows it; legendary cards carry a
 * slow gold-leaf sheen and give off motes; a mythic card has a light running round its edge and embers rising.
 * A card whose ability is still forming is shown faded and cannot be placed (4A). Under the name the card says what
 * its own code does (PO 2026-10-09, read by the engine, never the model's sentence): a row per case — a short
 * condition, then chips in the glyphs and colours of the tendency bars (push ↑ and drag ↓ apart, an add filled, a
 * multiplier outlined, a move an arrow); hovering says it in words. With one case the second line is the model's
 * sentence. A card that did not act once on this trip is dimmed and says so.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FormingCard, TableCard } from '@/features/plot-vector/table-model';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';
import Tooltip from '../shared/Tooltip.vue';
import { motes, tierRank } from './table-effects';
import { prefersReducedMotion } from './use-trip-walk';
import { useCardWords } from './card-words';

const props = defineProps<{
  card?: TableCard;
  forming?: FormingCard;
  fresh?: boolean;
  selected?: boolean;
  acting?: boolean;
  /** Sitting in a cell rather than in the hand. */
  placed?: boolean;
  /** The drag ghost following the pointer. */
  ghost?: boolean;
  /** The card being dragged, left behind as a faint outline. */
  lifted?: boolean;
  /** Its details are showing: the marks' own hint keeps quiet so the two do not overlap. */
  quietMarks?: boolean;
  /** On the board and did not act once on this trip. */
  idle?: boolean;
  /** Exact numbers on: the chips carry their numbers. */
  exact?: boolean;
}>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';

const kind = computed(() => props.card?.kind ?? props.forming?.kind ?? 'item');
const name = computed(() => props.card ? label(props.card.name) : props.forming?.name ?? '');
const line = computed(() => props.card ? label(props.card.line) : t('mainGame.vectorTable.detail.forming'));
const tier = computed(() => props.card?.tier);
const rank = computed(() => tierRank(tier.value));
const dots = computed(() => {
  const uses = props.card?.uses;
  if (!uses || uses.max > 5) return [];
  return Array.from({ length: uses.max }, (_, i) => i < uses.left);
});
const diamonds = computed(() => Math.min(3, props.card?.level?.value ?? 0));
const words = useCardWords(() => !!props.exact);
const behavior = computed(() => props.card?.behavior);
const rows = computed(() => (behavior.value ? words.value.face(behavior.value) : []));
const fxTip = computed(() => (behavior.value?.clauses.length ? words.value.faceTip(behavior.value) : ''));
/** One case leaves room for the model's sentence on the second line. */
const sayLine = computed(() => rows.value.length < 2);
/** Cases the face leaves out (it shows two; a narrow card one): their count, so the face never reads as complete. */
const moreWide = computed(() => Math.max(0, (behavior.value?.clauses.length ?? 0) - rows.value.length));
const moreNarrow = computed(() => Math.max(0, (behavior.value?.clauses.length ?? 0) - Math.min(1, rows.value.length)));
const charge = computed(() => {
  const c = props.card;
  return c?.resting && c.charge ? Math.min(1, c.charge.progress / c.charge.every) : null;
});

// ── From epic up the card leans toward the pointer; legendary and mythic give off motes while hovered. ──
const root = ref<HTMLElement>();
let moteTimer: ReturnType<typeof setInterval> | undefined;
const lively = () => rank.value >= 3 && !props.ghost && !props.forming && !prefersReducedMotion();
// The lean follows the pointer at most once a frame.
let leanFrame = 0, leanAt: { x: number; y: number } | null = null;
function onMove(e: PointerEvent): void {
  if (!lively() || !root.value || e.pointerType !== 'mouse') return;
  leanAt = { x: e.clientX, y: e.clientY };
  if (leanFrame) return;
  leanFrame = requestAnimationFrame(() => {
    leanFrame = 0;
    const el = root.value, at = leanAt;
    if (!el || !at) return;
    const r = el.getBoundingClientRect(), x = (at.x - r.left) / r.width, y = (at.y - r.top) / r.height;
    el.style.setProperty('--mx', `${x * 100}%`);
    el.style.setProperty('--my', `${y * 100}%`);
    el.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    el.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
  });
}
function onEnter(e: PointerEvent): void {
  const t0 = tier.value;
  if (!t0 || !lively() || e.pointerType !== 'mouse' || rank.value < 4 || !root.value) return;
  const el = root.value;
  motes(el, t0, t0 === 'mythic' ? 2 : 1);
  clearInterval(moteTimer);
  moteTimer = setInterval(() => motes(el, t0, t0 === 'mythic' ? 2 : 1), t0 === 'mythic' ? 220 : 380);
}
function onLeave(): void {
  clearInterval(moteTimer);
  cancelAnimationFrame(leanFrame);
  leanFrame = 0;
  root.value?.style.setProperty('--rx', '0deg');
  root.value?.style.setProperty('--ry', '0deg');
}
onBeforeUnmount(() => { clearInterval(moteTimer); cancelAnimationFrame(leanFrame); });
</script>

<template>
  <div
    ref="root"
    class="vcard"
    :class="[
      `vcard--${kind}`,
      tier && tier !== 'common' ? `vcard--${tier}` : '',
      {
        'vcard--forming': !!forming,
        'vcard--resting': card?.resting,
        'vcard--selected': selected,
        'vcard--acting': acting,
        'vcard--placed': placed,
        'vcard--ghost': ghost,
        'vcard--fresh': fresh,
        'vcard--lifted': lifted,
        'vcard--idle': idle && !ghost,
      },
    ]"
    :data-tier="tier"
    @pointermove="onMove"
    @pointerenter="onEnter"
    @pointerleave="onLeave"
  >
    <i v-if="rank >= 4 || fresh" class="vcard__aura" aria-hidden="true" />
    <span class="vcard__clip" aria-hidden="true">
      <i class="vcard__sheen" />
      <i v-if="rank >= 4" class="vcard__foil" />
      <i v-if="rank >= 3" class="vcard__glare" />
    </span>
    <i v-if="rank >= 5" class="vcard__run" aria-hidden="true"><i /></i>
    <i v-if="rank >= 1" class="vcard__edge" aria-hidden="true" />
    <span class="vcard__kind">{{ t(`mainGame.vectorTable.kind.${kind}`) }}</span>
    <span class="vcard__marks" aria-hidden="true">
      <i v-for="(full, i) in dots" :key="`d${i}`" class="vcard__dot" :class="{ 'vcard__dot--spent': !full }" />
      <i v-if="charge !== null" class="vcard__charge" :style="{ '--p': `${Math.round(charge * 100)}%` }" />
      <i v-for="i in diamonds" :key="`l${i}`" class="vcard__level" />
      <i v-if="card?.stored" class="vcard__stored" />
    </span>
    <strong class="vcard__name">{{ name }}</strong>
    <span v-if="rows.length && !ghost" class="vcard__sr">{{ fxTip }}</span>
    <!-- Not a control: `interactive` only keeps the hint from adding a tab stop inside the card. -->
    <Tooltip v-if="rows.length && !ghost" class="vcard__fx" :text="fxTip" interactive fixed :disabled="quietMarks || lifted" data-testid="vector-card-marks">
      <span class="vcard__fx-in">
        <span v-for="(row, r) in rows" :key="r" class="vcard__row" aria-hidden="true">
          <i v-for="(w, i) in row.when" :key="`w${i}`" class="vcard__when">{{ w }}</i>
          <i v-for="(c, i) in row.chips" :key="i" class="vcard__chip" :class="`vcard__chip--${c.frame}`" :style="{ '--c': c.color }">{{ c.text }}</i>
        </span>
        <i v-if="moreWide" class="vcard__when vcard__when--more vcard__more-wide" aria-hidden="true">{{ t('mainGame.vectorTable.do.more', { n: moreWide }) }}</i>
        <i v-if="moreNarrow" class="vcard__when vcard__when--more vcard__more-narrow" aria-hidden="true">{{ t('mainGame.vectorTable.do.more', { n: moreNarrow }) }}</i>
        <i v-if="behavior?.complex" class="vcard__when vcard__when--complex" aria-hidden="true">{{ t('mainGame.vectorTable.do.complex') }}</i>
      </span>
    </Tooltip>
    <span v-if="sayLine || !rows.length || ghost" class="vcard__line" :class="{ 'vcard__line--one': rows.length > 0 && !ghost }">{{ line }}</span>
    <span v-if="fresh" class="vcard__fresh">{{ t('mainGame.vectorTable.fresh') }}</span>
    <span v-else-if="idle && !ghost" class="vcard__idle">{{ t('mainGame.vectorTable.do.idle') }}</span>
  </div>
</template>

<style scoped>
/* The chips said in words for a screen reader (the chips themselves are glyphs). */
.vcard__sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.vcard {
  --tier: var(--tier-common);
  --mx: 50%;
  --my: 50%;
  --rx: 0deg;
  --ry: 0deg;
  --lift: 0px;
  position: relative;
  display: grid;
  align-content: start;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 22px 10px 9px;
  border-radius: 11px;
  background: linear-gradient(180deg, oklch(0.235 0.01 90), oklch(0.19 0.008 90));
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  color: var(--color-text);
  text-align: left;
  user-select: none;
  -webkit-user-select: none;
  /* A long press lifts the card: no callout or text menu from the browser. */
  -webkit-touch-callout: none;
  isolation: isolate;
  transform: perspective(700px) translateY(var(--lift)) rotateX(var(--rx)) rotateY(var(--ry));
  transition: transform var(--duration-slow) var(--ease-out), box-shadow var(--duration-normal) var(--ease-out), opacity var(--duration-normal) var(--ease-out);
}
.vcard:hover { transition: transform 120ms linear, box-shadow var(--duration-normal) var(--ease-out), opacity var(--duration-normal) var(--ease-out); }
/* A card that can be picked up rises under the pointer; fine and rare a little higher. Tier glows below override
   the shadow (:where keeps this rule's weight low). */
.vcard:where(:not(.vcard--ghost, .vcard--resting, .vcard--forming, .vcard--lifted, .vcard--selected)):hover { --lift: -3px; box-shadow: 0 10px 22px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08); }
.vcard--uncommon:where(:not(.vcard--ghost, .vcard--resting, .vcard--lifted, .vcard--selected)):hover, .vcard--rare:where(:not(.vcard--ghost, .vcard--resting, .vcard--lifted, .vcard--selected)):hover { --lift: -4px; }
.vcard__clip { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; pointer-events: none; z-index: 0; }
.vcard__kind, .vcard__marks, .vcard__name, .vcard__line, .vcard__fresh, .vcard__idle, .vcard__fx { z-index: 2; }
.vcard__kind { position: absolute; top: 6px; left: 10px; display: inline-flex; align-items: center; gap: 7px; font-size: 10px; letter-spacing: 0.06em; color: var(--color-text-muted); }
/* What the card does: a row per case, a quiet condition then chips (an add filled, a multiplier outlined). */
.vcard__fx { position: relative; display: block; cursor: default; min-width: 0; }
.vcard__fx-in { display: grid; gap: 3px; }
.vcard__row { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; min-width: 0; }
.vcard__when, .vcard__chip { font-style: normal; font-size: 10.5px; line-height: 15px; letter-spacing: 0; white-space: nowrap; }
/* A condition is a quiet neutral tag (square-ish), never in a quantity's colour, so it never reads as one. */
.vcard__when { padding: 0 4px; border-radius: 3px; color: var(--color-text-secondary); background: oklch(0.28 0.006 95); }
.vcard__when--complex, .vcard__when--more { justify-self: start; color: var(--color-text-muted); background: oklch(0.26 0.006 95); }
.vcard__more-narrow { display: none; }
.vcard__chip { padding: 0 5px; border-radius: 999px; color: var(--c); font-variant-numeric: tabular-nums; }
.vcard__chip--fill { background: color-mix(in oklch, var(--c) 16%, transparent); }
.vcard__chip--line { box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--c) 55%, transparent); }
.vcard__chip--plain { padding: 0 2px; }
/* A narrow card (a phone): one case on one line, smaller chips, no sentence; the rest is in its details. */
.vcard { container-type: inline-size; }
@container (max-width: 125px) {
  .vcard__fx-in > .vcard__row:nth-child(n + 2), .vcard__more-wide { display: none; }
  .vcard__more-narrow { display: inline; }
  .vcard__row { flex-wrap: nowrap; overflow: hidden; }
  .vcard__when, .vcard__chip { font-size: 9.5px; line-height: 14px; }
  .vcard__chip { padding: 0 3px; }
  .vcard__line--one { display: none; }
}
.vcard__marks { position: absolute; top: 7px; right: 9px; display: flex; align-items: center; gap: 3px; }
.vcard__dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-sage-400); }
.vcard__dot--spent { background: oklch(0.3 0.006 95); }
.vcard__level { width: 6px; height: 6px; background: var(--color-amber-300); transform: rotate(45deg) scale(0.85); border-radius: 1px; }
.vcard__stored { width: 6px; height: 6px; border-radius: 1.5px; background: var(--color-amber-400); opacity: 0.8; }
.vcard__charge {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: conic-gradient(var(--color-sage-400) var(--p, 0%), oklch(0.28 0.006 95) 0);
  -webkit-mask: radial-gradient(circle 3.5px, transparent 98%, #000 100%);
  mask: radial-gradient(circle 3.5px, transparent 98%, #000 100%);
}
.vcard__name { position: relative; font-family: var(--font-serif-cjk); font-size: 14.5px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.vcard__line {
  position: relative;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--color-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* Under a row of chips the model's sentence keeps to one quiet line. */
.vcard__line--one { -webkit-line-clamp: 1; font-size: 11px; color: var(--color-text-muted); }
.vcard__idle {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 10px;
  line-height: 15px;
  color: var(--color-text-muted);
}
.vcard__fresh {
  position: absolute;
  right: 8px;
  bottom: 6px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  color: oklch(0.2 0.02 75);
  background: var(--color-amber-400);
}

/* Kinds: a status reads warm and heavy. */
.vcard--status { background: linear-gradient(180deg, color-mix(in oklch, var(--color-danger) 16%, oklch(0.21 0.01 60)), oklch(0.18 0.01 60)); }

/* ── Tiers ── a light along the top edge; the rarer, the richer. */
.vcard--uncommon { --tier: var(--tier-uncommon); }
.vcard--rare { --tier: var(--tier-rare); }
.vcard--epic { --tier: var(--tier-epic); }
.vcard--legendary { --tier: var(--tier-legendary); }
.vcard--mythic { --tier: var(--tier-mythic); }
.vcard__edge { position: absolute; top: 0; left: 12px; right: 12px; height: 2px; border-radius: 0 0 2px 2px; background: var(--tier); z-index: 3; pointer-events: none;
  animation: vcard-edge-in 700ms var(--ease-out); }
/* The light draws itself along the top edge when the card's tier becomes known. */
@keyframes vcard-edge-in { from { opacity: 0; transform: scaleX(0.15); } }
.vcard--uncommon .vcard__edge { opacity: 0.85; }
.vcard--rare .vcard__edge { box-shadow: 0 0 8px var(--tier); }
.vcard--epic .vcard__edge { box-shadow: 0 0 10px var(--tier); }
.vcard--legendary .vcard__edge { left: 6px; right: 6px; box-shadow: 0 0 14px var(--tier); }
.vcard--mythic .vcard__edge { left: 4px; right: 4px; box-shadow: 0 0 16px var(--tier); }

/* Fine and rare: a sheen crosses the card on hover. */
.vcard__sheen { position: absolute; inset: -40% -70%; transform: translateX(-60%); opacity: 0;
  background: linear-gradient(105deg, transparent 42%, color-mix(in oklch, var(--tier) 16%, rgba(255, 255, 255, 0.08)) 50%, transparent 58%); }
.vcard--uncommon:hover .vcard__sheen, .vcard--rare:hover .vcard__sheen { animation: vcard-sheen 1s var(--ease-out) forwards; }
@keyframes vcard-sheen { from { opacity: 1; transform: translateX(-60%); } to { opacity: 1; transform: translateX(60%); } }
.vcard--rare:hover { box-shadow: 0 12px 26px rgba(0, 0, 0, 0.5), 0 0 0 1px color-mix(in oklch, var(--tier) 35%, transparent), 0 0 20px color-mix(in oklch, var(--tier) 22%, transparent); }

/* Epic and above: tinted face; a light follows the pointer while the card leans toward it. */
.vcard--epic, .vcard--legendary, .vcard--mythic { background: linear-gradient(180deg, color-mix(in oklch, var(--tier) 7%, oklch(0.235 0.01 90)), oklch(0.19 0.008 90)); }
.vcard__glare { position: absolute; inset: 0; opacity: 0; transition: opacity var(--duration-normal) var(--ease-out); mix-blend-mode: screen;
  background: radial-gradient(160px circle at var(--mx) var(--my), color-mix(in oklch, var(--tier) 28%, rgba(255, 255, 255, 0.14)), transparent 60%); }
.vcard--epic:hover .vcard__glare, .vcard--legendary:hover .vcard__glare, .vcard--mythic:hover .vcard__glare { opacity: 1; }
.vcard--epic:hover { box-shadow: 0 16px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px color-mix(in oklch, var(--tier) 45%, transparent), 0 0 26px color-mix(in oklch, var(--tier) 30%, transparent); }

/*
 * The endless lights move only opacity or position, so the graphics card carries them and the page is not
 * repainted every frame (a slow phone keeps its frames for the story and the shuttle).
 */
/* Legendary and mythic breathe, a new card glows twice: a glow layer behind the card fades in and out. */
.vcard__aura { position: absolute; inset: 0; border-radius: inherit; z-index: -1; pointer-events: none; opacity: 0;
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--tier) 22%, transparent), 0 0 20px color-mix(in oklch, var(--tier) 16%, transparent); }
.vcard--legendary .vcard__aura { animation: vcard-breathe 3.8s var(--ease-in-out) infinite; }
.vcard--mythic .vcard__aura { box-shadow: 0 0 0 1px color-mix(in oklch, var(--tier) 30%, transparent), 0 0 28px color-mix(in oklch, var(--tier) 26%, transparent);
  animation: vcard-breathe 3.2s var(--ease-in-out) infinite; }
.vcard--fresh:not(.vcard--legendary):not(.vcard--mythic) .vcard__aura { box-shadow: 0 0 22px color-mix(in oklch, var(--color-amber-400) 45%, transparent);
  animation: vcard-breathe 1.8s var(--ease-out) 2; }
@keyframes vcard-breathe { 50% { opacity: 1; } }
.vcard--legendary:hover .vcard__aura, .vcard--mythic:hover .vcard__aura { animation: none; opacity: 0; }

/* Legendary: a slow gold-leaf sheen — a wide strip of two tiles sliding one tile's width, so it loops seamlessly. */
.vcard__foil { position: absolute; top: 0; bottom: 0; left: 0; width: 560%; opacity: 0.45; will-change: transform;
  background-image: linear-gradient(115deg, transparent 18%, color-mix(in oklch, var(--tier) 14%, transparent) 32%, transparent 46%, color-mix(in oklch, var(--tier) 9%, transparent) 66%, transparent 84%);
  background-size: 50% 100%; background-repeat: repeat-x;
  animation: vcard-foil 8s linear infinite; }
@keyframes vcard-foil { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.vcard--legendary:hover { box-shadow: 0 18px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px color-mix(in oklch, var(--tier) 55%, transparent), 0 0 32px color-mix(in oklch, var(--tier) 36%, transparent); }
.vcard--legendary:hover .vcard__foil, .vcard--mythic:hover .vcard__foil { opacity: 0.95; animation-duration: 3s; }

/* Mythic: a light runs round the edge — a turning light seen only through a thin ring. */
.vcard__run { position: absolute; inset: -1px; border-radius: 12px; padding: 1.5px; z-index: 3; pointer-events: none; overflow: hidden;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude; }
.vcard__run > i { position: absolute; left: 50%; top: 50%; width: 300%; aspect-ratio: 1; translate: -50% -50%; will-change: transform;
  background: conic-gradient(transparent 0 62%, color-mix(in oklch, var(--tier) 60%, transparent) 72%, oklch(0.92 0.08 60) 78%, color-mix(in oklch, var(--tier) 60%, transparent) 84%, transparent 94%);
  animation: vcard-run 4.5s linear infinite; }
@keyframes vcard-run { to { rotate: 360deg; } }
.vcard--mythic:hover { box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px color-mix(in oklch, var(--tier) 60%, transparent), 0 0 42px color-mix(in oklch, var(--tier) 42%, transparent); }
.vcard--mythic:hover .vcard__run > i { animation-duration: 1.8s; }

/* States. */
.vcard--resting { opacity: 0.55; }
.vcard--forming { opacity: 0.5; background: repeating-linear-gradient(135deg, oklch(0.19 0.008 90) 0 6px, oklch(0.21 0.008 90) 6px 12px); }
.vcard--forming .vcard__line { font-style: italic; }
.vcard--selected { --lift: -6px; box-shadow: 0 10px 22px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--color-sage-400), 0 0 18px color-mix(in oklch, var(--color-sage-400) 35%, transparent); }
.vcard--acting { box-shadow: 0 0 0 1px var(--color-amber-400), 0 0 24px color-mix(in oklch, var(--color-amber-400) 45%, transparent); }
.vcard--ghost { transform: rotate(-2deg) scale(1.05); box-shadow: 0 18px 36px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--color-sage-400); animation: vcard-pick 160ms var(--ease-out); }
/* Picked up: the card rises from the table, its shadow deepening. */
@keyframes vcard-pick { from { transform: none; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); } }
.vcard--lifted { opacity: 0.3; }
/* Did not act on this trip: it sits back, its chips greyed, so the cards that worked stand out. */
.vcard--idle { opacity: 0.62; }
.vcard--idle .vcard__chip, .vcard--idle .vcard__when { filter: saturate(0.25); }
@media (prefers-reduced-motion: reduce) {
  .vcard, .vcard:hover { transition: none; transform: none; }
  .vcard--ghost, .vcard__aura, .vcard__foil, .vcard__run > i, .vcard__edge { animation: none !important; }
  .vcard__sheen { display: none; }
}
</style>
