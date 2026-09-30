<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md · Plot-vector card table
/**
 * The six cells and the shuttle (phase 7). A line lays the cells in a row (two rows on a narrow screen, still one
 * road: 01 02 03 / 06 05 04); a ring sets them around a loop with the shuttle riding a track just outside them.
 * Switching shape glides every cell to its new place. The tendencies sit under the line or in the ring's hub.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '../shared/Tooltip.vue';
import VectorCardFace from './VectorCardFace.vue';
import { ringGeometry, RING_ORDER } from './ring-geometry';
import { prefersReducedMotion, type WalkFloat } from './use-trip-walk';
import type { PassSign, TableCard, TableCell, TripWalk } from '@/features/plot-vector/table-model';
import type { BoardShape } from '@/features/plot-vector/vector-board';
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
}>();
const emit = defineEmits<{
  (e: 'cell-tap', cell: string): void;
  (e: 'cell-key', cell: string): void;
  (e: 'card-down', event: PointerEvent, card: string, cell: string): void;
  (e: 'card-enter', card: string, el: HTMLElement): void;
  (e: 'card-leave', card: string): void;
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

function roleText(cell: TableCell): string {
  if (cell.role === 'converter') return t(props.shape === 'ring' ? 'mainGame.vectorTable.role.converterRing' : 'mainGame.vectorTable.role.converterLine');
  return t(`mainGame.vectorTable.role.${cell.role}`);
}
function cellLabel(cell: TableCell): string {
  const card = cell.card ? props.cards[cell.card] : undefined;
  return card ? t('mainGame.vectorTable.cell.placed', { cell: cell.id, name: label(card.name) }) : t('mainGame.vectorTable.cell.empty', { cell: cell.id });
}
const SIGNS: Record<PassSign, string> = { push: '↑', drag: '↓', social: '◇', chance: '✦', route: '↻', store: '▣' };

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
function placeShuttle(cell: string, from?: string): void {
  cancelAnimationFrame(glideFrame);
  if (ring.value && ringPath) {
    const target = ringAt[cell] ?? 0;
    const put = (l: number) => {
      const p = ringPath!.getPointAtLength(((l % ringTotal) + ringTotal) % ringTotal);
      shuttle.value = { x: p.x, y: p.y };
    };
    if (from === undefined || from === cell || prefersReducedMotion()) { put(target); return; }
    const start = ringAt[from] ?? 0;
    // Forward round the loop, or backward when the shuttle was turned.
    let end = target;
    if (props.back) { if (end > start) end -= ringTotal; } else if (end < start) end += ringTotal;
    const t0 = performance.now(), ms = 170;
    const frame = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      put(start + (end - start) * (1 - (1 - k) * (1 - k)));
      if (k < 1) glideFrame = requestAnimationFrame(frame);
    };
    glideFrame = requestAnimationFrame(frame);
    return;
  }
  const el = cellEls.get(cell);
  if (!el || narrowLine.value) { shuttle.value = null; return; }
  shuttle.value = { x: el.offsetLeft + el.offsetWidth / 2, y: el.offsetTop + el.offsetHeight + 14 };
}
watch(() => props.at, (cell, from) => placeShuttle(cell, from));
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
    el.animate([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }],
      { duration: 520, delay: i++ * 18, easing: ease, fill: 'backwards' });
  }
  root.value.animate([{ height: `${startHeight}px` }, { height: `${root.value.offsetHeight}px` }], { duration: 520, easing: ease });
  root.value.querySelector('.vtrack__rail')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: 200, easing: ease, fill: 'backwards' });
}, { flush: 'post' });

const trackStyle = computed(() => (ring.value ? { height: `${ring.value.height}px` } : undefined));
const hubStyle = computed(() => (ring.value ? { top: `${ring.value.hubTop}px` } : undefined));
const bar = (value: number, bipolar: boolean) => {
  const v = Math.max(bipolar ? -1 : 0, Math.min(1, value));
  if (!bipolar) return { width: `${v * 100}%` };
  return { left: v >= 0 ? '50%' : `${50 + v * 50}%`, width: `${Math.abs(v) * 50}%`, background: v >= 0 ? 'var(--color-sage-400)' : 'var(--color-danger)' };
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
      <Tooltip class="vcell__role" :text="roleText(cell)" fixed>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
          <template v-if="cell.role === 'resonance'"><circle cx="4.5" cy="6" r="3" /><circle cx="7.5" cy="6" r="3" /></template>
          <template v-else-if="cell.role === 'converter'"><path d="M2 4h7.5M7.5 2l2 2-2 2M10 8H2.5M4.5 6l-2 2 2 2" /></template>
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
        class="vcell__card"
        :class="{ 'vcell__card--auto': cell.role === 'status' }"
        @pointerdown="cell.role !== 'status' && emit('card-down', $event, cell.card, cell.id)"
        @pointerenter="emit('card-enter', cell.card, $event.currentTarget as HTMLElement)"
        @pointerleave="emit('card-leave', cell.card)"
      />
      <span v-for="f in floats.filter(x => x.cell === cell.id)" :key="f.id" class="vcell__float" aria-hidden="true">{{ SIGNS[f.sign] }}</span>
    </div>
    <span v-if="shuttle" class="vtrack__shuttle" :style="{ left: `${shuttle.x}px`, top: `${shuttle.y}px` }" aria-hidden="true" />
    <div class="vtrack__hub" :style="hubStyle" role="img" :aria-label="t('mainGame.vectorTable.tendency.label')">
      <div class="vtrack__tend">
        <div class="vtrack__meter vtrack__meter--bipolar"><i :style="tendency ? bar(tendency.s, true) : { width: 0 }" /></div>
        <span>{{ t('mainGame.vectorTable.tendency.s') }}</span>
      </div>
      <div class="vtrack__tend">
        <div class="vtrack__meter"><i :style="tendency ? bar(tendency.y, false) : { width: 0 }" /></div>
        <span>{{ t('mainGame.vectorTable.tendency.y') }}</span>
      </div>
      <div class="vtrack__tend">
        <div class="vtrack__meter"><i :style="tendency ? bar(tendency.j, false) : { width: 0 }" /></div>
        <span>{{ t('mainGame.vectorTable.tendency.j') }}</span>
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
  transition: left 200ms var(--ease-out), top 200ms var(--ease-out);
  pointer-events: none;
}
.vtrack--ring .vtrack__shuttle { transition: none; }

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
  background: var(--color-sage-400);
  transition: left var(--duration-slow) var(--ease-out), width var(--duration-slow) var(--ease-out), background var(--duration-slow) var(--ease-out);
}
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
