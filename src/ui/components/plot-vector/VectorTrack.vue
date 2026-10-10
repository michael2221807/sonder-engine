<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.2 · Plot-vector card table
/**
 * The six cells and the shuttle (phase 7). A line lays the cells in a row (two rows on a narrow screen, still one
 * road: 01 02 03 / 06 05 04); a ring sets them around a loop with the shuttle riding a track just outside them.
 * Switching shape glides every cell to its new place. The tendencies sit under the line or in the ring's hub.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '../shared/Tooltip.vue';
import VectorCardFace from './VectorCardFace.vue';
import VectorConverterPicker from './VectorConverterPicker.vue';
import { ringGeometry, RING_ORDER } from './ring-geometry';
import { prefersReducedMotion, type WalkFloat } from './use-trip-walk';
import { sweepAcross } from './table-effects';
import { CHANNEL_KEY, CHANNEL_MARK, MARK_COLOR, MARK_GLYPH, SIGN_MARK } from './effect-marks';
import type { PassSign, TableCard, TableCell, TripWalk } from '@/features/plot-vector/table-model';
import type { BoardShape, ConverterRule } from '@/features/plot-vector/vector-board';
import type { LocalizedLabel } from '@/engine/plot-vector/core/types';
import type { DropTarget } from './use-card-drag';

const props = defineProps<{
  cells: TableCell[];
  cards: Record<string, TableCard>;
  shape: BoardShape;
  at: string;
  back: boolean;
  passing: string | null;
  acting: ReadonlySet<string>;
  floats: WalkFloat[];
  tendency: TripWalk['tendency'] | null;
  selected: string | null;
  dragging: boolean;
  over: DropTarget;
  fresh: ReadonlySet<string>;
  /** The card being dragged out of its cell, left behind as a faint outline. */
  lifting?: string | null;
  /** The card whose details are showing: its marks keep their own hint quiet. */
  quiet?: string | null;
  /** What the converter cell turns into what (PO 2026-10-09, A). */
  converter: ConverterRule;
  /** The rule cannot be changed now (a round running, a replay, nothing loaded). */
  converterLocked?: boolean;
  /** Cards on the board that did not act once on this trip. */
  idle?: readonly string[];
  /** Exact numbers on: the chips carry their numbers. */
  exact?: boolean;
}>();
const emit = defineEmits<{
  (e: 'cell-tap', cell: string): void;
  (e: 'cell-key', cell: string): void;
  (e: 'card-down', event: PointerEvent, card: string, cell: string): void;
  (e: 'card-enter', card: string, el: HTMLElement): void;
  (e: 'card-leave', card: string): void;
  (e: 'converter', rule: ConverterRule): void;
}>();
const { t, locale } = useI18n();
const label = (value?: LocalizedLabel) => value ? (locale.value === 'en' ? value.en : value.zh) : '';

const root = ref<HTMLElement>();
const width = ref(0);
let resize: ResizeObserver | undefined;
let resizeFrame = 0;
onMounted(() => {
  if (!root.value) return;
  width.value = root.value.clientWidth;
  // One measurement per frame while the window is being resized.
  resize = new ResizeObserver(entries => {
    const next = entries[0].contentRect.width;
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { width.value = next; });
  });
  resize.observe(root.value);
});
onBeforeUnmount(() => { resize?.disconnect(); cancelAnimationFrame(resizeFrame); });

const ring = computed(() => props.shape === 'ring' && width.value > 0 ? ringGeometry(width.value) : null);
const narrowLine = computed(() => props.shape === 'line' && width.value > 0 && width.value < 560);
const cellStyle = (id: string) => {
  const box = ring.value?.cells[id];
  return box ? { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` } : undefined;
};

const channelName = (ch: ConverterRule['from']) => t(`mainGame.vectorTable.channel.${CHANNEL_KEY[ch]}`);
function roleText(cell: TableCell): string {
  if (cell.role === 'converter') {
    return t(props.converterLocked ? 'mainGame.vectorTable.role.converterLocked' : 'mainGame.vectorTable.role.converter',
      { from: channelName(props.converter.from), to: channelName(props.converter.to) });
  }
  return t(`mainGame.vectorTable.role.${cell.role}`);
}
const glyph = (ch: ConverterRule['from']) => MARK_GLYPH[CHANNEL_MARK[ch]];
const glyphColor = (ch: ConverterRule['from']) => MARK_COLOR[CHANNEL_MARK[ch]];

// ── The converter's rule: its mark on cell 03 opens the picker. ──
const picking = shallowRef<HTMLElement | null>(null);
function openPicker(e: MouseEvent): void {
  if (props.converterLocked) return;
  picking.value = picking.value ? null : (e.currentTarget as HTMLElement);
}
watch(() => props.converterLocked, locked => { if (locked) picking.value = null; });
const idleSet = computed(() => new Set(props.idle ?? []));
function cellLabel(cell: TableCell): string {
  const card = cell.card ? props.cards[cell.card] : undefined;
  return card ? t('mainGame.vectorTable.cell.placed', { cell: cell.id, name: label(card.name) }) : t('mainGame.vectorTable.cell.empty', { cell: cell.id });
}
/** A pass's sign floats up in the same glyph and colour as the card marks and the bars (PO 2026-10-01). */
const signGlyph = (sign: PassSign) => MARK_GLYPH[SIGN_MARK[sign]];
const signColor = (sign: PassSign) => MARK_COLOR[SIGN_MARK[sign]];

// ── The shuttle ─────────────────────────────────────────────────────
const shuttle = ref<{ x: number; y: number } | null>(null);
const cellEls = new Map<string, HTMLElement>();
const bindCell = (id: string) => (el: unknown) => { if (el instanceof HTMLElement) cellEls.set(id, el); else cellEls.delete(id); };
let ringPath: SVGPathElement | null = null;
const ringAt: Record<string, number> = {};
let ringTotal = 0;
let glideFrame = 0;

/** Lengths along the ring track to each cell's point (measured once per layout). */
function measureRing(): void {
  const g = ring.value;
  ringPath = root.value?.querySelector<SVGPathElement>('.vtrack__rail-path') ?? null;
  if (!g || !ringPath) return;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = ringPath.ownerSVGElement!;
  let total = 0;
  g.segments.forEach((d, i) => {
    ringAt[RING_ORDER[i]] = total;
    const piece = document.createElementNS(ns, 'path');
    piece.setAttribute('d', d);
    svg.appendChild(piece);
    total += piece.getTotalLength();
    piece.remove();
  });
  ringTotal = total;
}
// A fading trail behind the moving shuttle: the last positions, a few frames apart.
const trail = ref<Array<{ x: number; y: number }>>([]);
let history: Array<{ x: number; y: number }> = [];
function record(p: { x: number; y: number }): void {
  shuttle.value = p;
  history.unshift(p);
  if (history.length > 30) history.length = 30;
  trail.value = [3, 6, 9, 12, 15, 18, 21, 24].map(i => history[i]).filter((q): q is { x: number; y: number } => !!q);
}
/** The line's point for a cell: under its middle, on the rail. */
function linePoint(cell: string): { x: number; y: number } | null {
  const el = cellEls.get(cell);
  return el && !narrowLine.value ? { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight + 14 } : null;
}
function glide(ms: number, at: (k: number) => { x: number; y: number }): void {
  const t0 = performance.now();
  const frame = (now: number) => {
    const k = Math.min(1, Math.max(0, now - t0) / ms);
    record(at(1 - (1 - k) * (1 - k)));
    if (k < 1) glideFrame = requestAnimationFrame(frame);
  };
  glideFrame = requestAnimationFrame(frame);
}
function placeShuttle(cell: string, from?: string): void {
  cancelAnimationFrame(glideFrame);
  const still = from === undefined || from === cell || prefersReducedMotion();
  if (ring.value && ringPath) {
    const target = ringAt[cell] ?? 0;
    const pointAt = (l: number) => { const p = ringPath!.getPointAtLength(((l % ringTotal) + ringTotal) % ringTotal); return { x: p.x, y: p.y }; };
    if (still) { shuttle.value = pointAt(target); return; }
    const start = ringAt[from!] ?? 0;
    // Forward round the loop, or backward when the shuttle was turned.
    let end = target;
    if (props.back) { if (end > start) end -= ringTotal; } else if (end < start) end += ringTotal;
    glide(170, k => pointAt(start + (end - start) * k));
    return;
  }
  const to = linePoint(cell);
  if (!to) { shuttle.value = null; return; }
  const a = from !== undefined ? linePoint(from) : null;
  if (still || !a) { shuttle.value = to; return; }
  glide(170, k => ({ x: a.x + (to.x - a.x) * k, y: a.y + (to.y - a.y) * k }));
}
watch(() => props.at, (cell, from) => placeShuttle(cell, from));
// The walk has settled: the trail fades away and the three leanings settle into place.
watch(() => props.passing, (cell, before) => {
  if (cell !== null || before === null) return;
  history = [];
  trail.value = [];
  if (props.tendency) settleMeters();
});
function settleMeters(): void {
  if (prefersReducedMotion() || !root.value) return;
  root.value.querySelectorAll<HTMLElement>('.vtrack__meter').forEach((el, i) => {
    el.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(2.2)', offset: 0.35 }, { transform: 'scaleY(1)' }],
      { duration: 560, delay: 120 + i * 90, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  });
}
// A card the shuttle passes and that acts catches a sweep of light in the shuttle's direction.
watch(() => props.passing, cell => {
  if (!cell) return;
  const card = props.cells.find(c => c.id === cell)?.card;
  if (!card || !props.acting.has(card)) return;
  const el = cellEls.get(cell)?.querySelector<HTMLElement>('.vcard');
  if (el) sweepAcross(el, props.back);
});
watch([ring, narrowLine, width], async () => { await nextTick(); measureRing(); placeShuttle(props.at); });
onBeforeUnmount(() => cancelAnimationFrame(glideFrame));

// ── Switching shape: every cell glides from where it was ─────────────
let before: Map<string, DOMRect> | null = null;
let heightBefore = 0;
watch(() => props.shape, () => {
  before = new Map([...cellEls].map(([id, el]) => [id, el.getBoundingClientRect()]));
  heightBefore = root.value?.offsetHeight ?? 0;
}, { flush: 'pre' });
watch(() => props.shape, async () => {
  // Take this switch's starting places now: a quick second switch must not overwrite them.
  const start = before, startHeight = heightBefore;
  before = null;
  await nextTick();
  measureRing();
  placeShuttle(props.at);
  if (!start || prefersReducedMotion() || !root.value) return;
  const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
  let i = 0;
  for (const [id, el] of cellEls) {
    const a = start.get(id), b = el.getBoundingClientRect();
    if (!a) continue;
    el.animate(arcFrames(a.left - b.left, a.top - b.top), { duration: 560, delay: i++ * 18, easing: ease, fill: 'backwards' });
  }
  root.value.animate([{ height: `${startHeight}px` }, { height: `${root.value.offsetHeight}px` }], { duration: 520, easing: ease });
  // The track is drawn like one stroke of ink: round the ring from 01, or along the line from the left.
  if (ringPath && ringTotal > 0) {
    ringPath.style.strokeDasharray = `${ringTotal}`;
    ringPath.animate([{ strokeDashoffset: ringTotal }, { strokeDashoffset: 0 }], { duration: 1100, delay: 180, easing: ease, fill: 'backwards' })
      .finished.then(() => { if (ringPath) ringPath.style.strokeDasharray = ''; }).catch(() => {});
  } else if (!ring.value && !narrowLine.value) {
    try {
      root.value.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { pseudoElement: '::before', duration: 800, delay: 180, easing: ease, fill: 'backwards' });
    } catch { /* this browser cannot animate the rail: it simply appears */ }
  }
}, { flush: 'post' });
/** A cell's way from its old place to its new one, bowed into a gentle arc (a fifth of the distance to one side). */
function arcFrames(dx: number, dy: number): Keyframe[] {
  const BOW = 0.2, STEPS = 10;
  return Array.from({ length: STEPS + 1 }, (_, s) => {
    const k = s / STEPS, off = Math.sin(Math.PI * k) * BOW;
    return { transform: `translate(${(1 - k) * dx - off * dy}px, ${(1 - k) * dy + off * dx}px)`, offset: k };
  });
}

const trackStyle = computed(() => (ring.value ? { height: `${ring.value.height}px` } : undefined));
const hubStyle = computed(() => (ring.value ? { top: `${ring.value.hubTop}px` } : undefined));
const bar = (value: number, bipolar: boolean) => {
  const v = Math.max(bipolar ? -1 : 0, Math.min(1, value));
  if (!bipolar) return { width: `${v * 100}%` };
  return { left: v >= 0 ? '50%' : `${50 + v * 50}%`, width: `${Math.abs(v) * 50}%`, background: v >= 0 ? MARK_COLOR.up : MARK_COLOR.down };
};
</script>

<template>
  <div
    ref="root"
    class="vtrack"
    :class="[`vtrack--${shape}`, { 'vtrack--narrow': narrowLine || ring?.narrow, 'vtrack--dragging': dragging }]"
    :style="trackStyle"
  >
    <svg v-if="ring" class="vtrack__rail" :viewBox="`0 0 ${width} ${ring.height}`" aria-hidden="true">
      <path class="vtrack__rail-path" :d="ring.path" />
    </svg>
    <div
      v-for="cell in cells"
      :key="cell.id"
      :ref="bindCell(cell.id)"
      class="vcell"
      :class="[
        `vcell--${cell.role}`,
        {
          'vcell--empty': !cell.card,
          'vcell--pass': passing === cell.id,
          'vcell--hint': (dragging || selected) && cell.role !== 'status',
          'vcell--over': over === cell.id,
        },
      ]"
      :style="cellStyle(cell.id)"
      :data-cell="cell.id"
      :data-drop-cell="cell.role !== 'status' ? cell.id : undefined"
      :role="cell.role !== 'status' ? 'button' : undefined"
      :tabindex="cell.role !== 'status' ? 0 : undefined"
      :aria-label="cellLabel(cell)"
      @click="emit('cell-tap', cell.id)"
      @focus="cell.card && emit('card-enter', cell.card, $event.currentTarget as HTMLElement)"
      @blur="cell.card && emit('card-leave', cell.card)"
      @keydown.enter.self.prevent="emit('cell-key', cell.id)"
      @keydown.space.self.prevent="emit('cell-key', cell.id)"
    >
      <span class="vcell__num">{{ cell.id }}</span>
      <Tooltip v-if="cell.role === 'converter'" class="vcell__role vcell__role--conv" :text="roleText(cell)" interactive fixed :disabled="!!picking">
        <button
          type="button"
          class="vcell__conv"
          :aria-label="roleText(cell)"
          :aria-expanded="!!picking"
          :disabled="converterLocked"
          data-testid="vector-converter"
          @click.stop="openPicker"
          @keydown.enter.stop
          @keydown.space.stop
        >
          <span :style="{ color: glyphColor(converter.from) }">{{ glyph(converter.from) }}</span><span class="vcell__conv-arrow">→</span><span :style="{ color: glyphColor(converter.to) }">{{ glyph(converter.to) }}</span>
        </button>
      </Tooltip>
      <Tooltip v-else class="vcell__role" :text="roleText(cell)" fixed>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <template v-if="cell.role === 'resonance'"><circle cx="4.5" cy="6" r="3" /><circle cx="7.5" cy="6" r="3" /></template>
          <template v-else-if="cell.role === 'status'"><path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" /></template>
          <template v-else><path d="M6 1.5v9M1.5 6h9M3 3l6 6M9 3 3 9" stroke-width="0.9" /></template>
        </svg>
      </Tooltip>
      <VectorCardFace
        v-if="cell.card && cards[cell.card]"
        :card="cards[cell.card]"
        placed
        :acting="acting.has(cell.card)"
        :fresh="fresh.has(cell.card)"
        :selected="selected === cell.card"
        :lifted="lifting === cell.card"
        :quiet-marks="quiet === cell.card"
        :idle="idleSet.has(cell.card)"
        :exact="exact"
        :data-card="cell.card"
        class="vcell__card"
        :class="{ 'vcell__card--auto': cell.role === 'status' }"
        @pointerdown="cell.role !== 'status' && emit('card-down', $event, cell.card, cell.id)"
        @pointerenter="emit('card-enter', cell.card, $event.currentTarget as HTMLElement)"
        @pointerleave="emit('card-leave', cell.card)"
      />
      <span v-for="f in floats.filter(x => x.cell === cell.id)" :key="f.id" class="vcell__float" :style="{ color: signColor(f.sign) }" aria-hidden="true">{{ signGlyph(f.sign) }}</span>
    </div>
    <span v-for="(p, i) in trail" :key="`t${i}`" class="vtrack__trail" :style="{ left: `${p.x}px`, top: `${p.y}px`, opacity: 0.34 - i * 0.04, transform: `scale(${1 - i * 0.09})` }" aria-hidden="true" />
    <VectorConverterPicker v-if="picking" :rule="converter" :anchor="picking" @pick="emit('converter', $event)" @close="picking = null" />
    <span v-if="shuttle" class="vtrack__shuttle" :style="{ left: `${shuttle.x}px`, top: `${shuttle.y}px` }" aria-hidden="true" />
    <div class="vtrack__hub" :style="hubStyle" role="img" :aria-label="t('mainGame.vectorTable.tendency.label')">
      <!-- The same marks and colours as the cards: ↑ toward 顺, ↓ toward 逆, ◇ relations, ✦ chances. -->
      <div class="vtrack__tend">
        <div class="vtrack__meter vtrack__meter--bipolar"><i :style="tendency ? bar(tendency.s, true) : { width: 0 }" /></div>
        <span class="vtrack__ends">
          <span :style="{ color: MARK_COLOR.down }">{{ MARK_GLYPH.down }} {{ t('mainGame.vectorTable.legend.strain') }}</span>
          <span :style="{ color: MARK_COLOR.up }">{{ t('mainGame.vectorTable.legend.ease') }} {{ MARK_GLYPH.up }}</span>
        </span>
      </div>
      <div class="vtrack__tend" :style="{ '--fill': MARK_COLOR.social }">
        <div class="vtrack__meter"><i :style="tendency ? bar(tendency.y, false) : { width: 0 }" /></div>
        <span :style="{ color: MARK_COLOR.social }">{{ MARK_GLYPH.social }} {{ t('mainGame.vectorTable.tendency.y') }}</span>
      </div>
      <div class="vtrack__tend" :style="{ '--fill': MARK_COLOR.chance }">
        <div class="vtrack__meter"><i :style="tendency ? bar(tendency.j, false) : { width: 0 }" /></div>
        <span :style="{ color: MARK_COLOR.chance }">{{ MARK_GLYPH.chance }} {{ t('mainGame.vectorTable.tendency.j') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vtrack {
  position: relative;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 26px 12px;
  padding: 24px 0 0;
}
/* The line's rail, under the cells: the shuttle rides it. */
.vtrack--line:not(.vtrack--narrow)::before {
  content: '';
  transform-origin: left center;
  position: absolute;
  left: 4%;
  right: 4%;
  top: calc(24px + 116px + 14px);
  height: 1px;
  background: linear-gradient(90deg, transparent, oklch(0.34 0.02 95) 12%, oklch(0.34 0.02 95) 88%, transparent);
}
.vtrack--line:not(.vtrack--narrow) { row-gap: 34px; }
.vtrack--line.vtrack--narrow { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 26px 10px; }
.vtrack--line.vtrack--narrow .vcell[data-cell='04'] { grid-column: 3; grid-row: 2; }
.vtrack--line.vtrack--narrow .vcell[data-cell='05'] { grid-column: 2; grid-row: 2; }
.vtrack--line.vtrack--narrow .vcell[data-cell='06'] { grid-column: 1; grid-row: 2; }
.vtrack--ring { display: block; padding: 0; }

.vtrack__rail { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.vtrack__rail-path { fill: none; stroke: oklch(0.34 0.02 95); stroke-width: 1; }

.vcell {
  position: relative;
  height: 116px;
  border-radius: 14px;
  background: color-mix(in oklch, var(--color-surface) 80%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-border) 80%, transparent);
  transition: box-shadow var(--duration-normal) var(--ease-out), background var(--duration-normal) var(--ease-out);
  outline: none;
}
.vtrack--ring .vcell { position: absolute; z-index: 1; }
.vtrack--narrow .vcell { height: 100px; }
.vcell:focus-visible { box-shadow: inset 0 0 0 1px var(--color-sage-400), 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 25%, transparent); }
.vcell__num {
  position: absolute;
  top: -19px;
  left: 4px;
  font-size: 10px;
  letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
.vcell__role { position: absolute; top: -20px; right: 4px; color: var(--color-sage-700); display: inline-flex; }
/* The converter's rule is its mark, and a button: it opens the picker. */
.vcell__role--conv { top: -22px; right: 2px; }
.vcell__conv {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 1px 6px;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  font: inherit;
  font-size: 11px;
  line-height: 15px;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}
.vcell__conv:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 45%, transparent); }
.vcell__conv:disabled { cursor: default; opacity: 0.7; }
.vcell__conv:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.vcell__conv-arrow { color: var(--color-text-muted); }
.vcell--empty::after {
  content: '';
  position: absolute;
  inset: 10px;
  border-radius: 10px;
  border: 1px dashed oklch(0.28 0.006 95);
  pointer-events: none;
}
.vcell--status { background: color-mix(in oklch, var(--color-danger) 6%, var(--color-surface)); }
.vcell--hint { box-shadow: inset 0 0 0 1px var(--color-sage-600), 0 0 18px color-mix(in oklch, var(--color-sage-400) 22%, transparent); cursor: pointer; }
.vcell--over { background: color-mix(in oklch, var(--color-sage-400) 12%, var(--color-surface)); box-shadow: inset 0 0 0 1px var(--color-sage-400); }
.vcell--pass { box-shadow: inset 0 0 0 1px var(--color-amber-600), 0 0 22px color-mix(in oklch, var(--color-amber-400) 26%, transparent); }
.vcell__card { position: absolute; inset: 2px; width: auto; height: auto; cursor: grab; touch-action: none; }
.vcell__card--auto { cursor: default; }
.vtrack--dragging .vcell__card { cursor: grabbing; }
.vcell__float {
  position: absolute;
  top: 18px;
  left: 50%;
  z-index: 2;
  font-size: 13px;
  color: var(--color-amber-300);
  pointer-events: none;
  animation: vcell-rise 900ms var(--ease-out) forwards;
}
@keyframes vcell-rise {
  from { opacity: 0; transform: translate(-50%, 6px); }
  20% { opacity: 1; }
  to { opacity: 0; transform: translate(-50%, -22px); }
}

.vtrack__shuttle {
  position: absolute;
  z-index: 3;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  background: var(--color-amber-300);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-amber-400) 25%, transparent), 0 0 18px var(--color-amber-400);
  pointer-events: none;
}
.vtrack__trail {
  position: absolute;
  z-index: 2;
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  border-radius: 50%;
  background: var(--color-amber-400);
  box-shadow: 0 0 8px var(--color-amber-400);
  pointer-events: none;
}

.vtrack__hub {
  grid-column: 1 / -1;
  display: flex;
  justify-content: center;
  gap: 28px;
  padding: 14px 0 4px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.vtrack--ring .vtrack__hub { position: absolute; left: 50%; transform: translate(-50%, -50%); padding: 0; z-index: 2; }
.vtrack--ring.vtrack--narrow .vtrack__hub { flex-direction: column; gap: 6px; }
.vtrack--line.vtrack--narrow .vtrack__hub { gap: 14px; }
.vtrack__tend { display: grid; justify-items: center; gap: 6px; }
.vtrack__meter { position: relative; width: 84px; height: 6px; border-radius: 3px; background: oklch(0.22 0.006 95); overflow: hidden; }
.vtrack--narrow .vtrack__meter { width: 70px; }
.vtrack__meter i {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 3px;
  background: var(--fill, var(--ch-push));
  transition: left var(--duration-slow) var(--ease-out), width var(--duration-slow) var(--ease-out), background var(--duration-slow) var(--ease-out);
}
.vtrack__ends { display: flex; justify-content: space-between; width: 100%; gap: 8px; }
.vtrack__meter--bipolar::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: oklch(0.3 0.006 95);
}
@media (prefers-reduced-motion: reduce) {
  .vcell, .vtrack__shuttle, .vtrack__meter i { transition: none; }
  .vcell__float { animation: none; opacity: 0; }
}
</style>
