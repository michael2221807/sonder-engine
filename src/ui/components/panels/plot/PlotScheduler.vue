<script setup lang="ts">
// Design: docs/design/plot-parallel-threads-scheduler.md §5 (scheduler view), D4 (axis)
// Visual spec: docs/demo/plot-scheduler-A-lanes.html (approved 2026-08-22)
// App doc: docs/user-guide/pages/game-plot.md §时间线视图
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import PlotThreadLane from './PlotThreadLane.vue';
import type { PlotArc, PendingNodeConfirmation } from '@/engine/plot/types';
import { evaluateThreadActivation } from '@/engine/plot/thread-trigger';
import {
  layoutThreads, buildAxis, collectDateSamples,
  type AxisMode, type LayoutLane,
} from './scheduler-layout';

const { t } = useI18n();

// Proportions (2026-08-23): rows/blocks were too thin for the panel they sit in
// (a one-thread save rendered as a 110px strip over an empty page). The track now
// fills the panel height and the rhythm is 76px rows / 40px blocks / 44px per round.
const PX_ROUND = 44;
const PX_DAY = 88;
/** Sticky head column: 196px on desktop; on phones ~26% of the viewport (≥ 96px) so the
    blocks keep most of the width (2026-08-23: 196px was half a 390px screen). */
const HEAD_W_DESKTOP = 196;
const viewportW = ref(typeof window === 'undefined' ? 1920 : window.innerWidth);
function onViewportResize(): void { viewportW.value = window.innerWidth; }
window.addEventListener('resize', onViewportResize);
onBeforeUnmount(() => window.removeEventListener('resize', onViewportResize));
const HEAD_W = computed(() => (viewportW.value < 640 ? Math.max(96, Math.round(viewportW.value * 0.26)) : HEAD_W_DESKTOP));
const LANE_H = 76;
const DONE_H = 40;
const RULER_H = 46;

const props = defineProps<{
  arcs: PlotArc[];
  focusArcId: string | null;
  currentRound: number;
  axis: AxisMode;
  pendingConfirmations: PendingNodeConfirmation[];
  maxActiveThreads: number;
  /** Thread whose outline the AI is still decomposing (progress shown on its lane). */
  generatingArcId?: string | null;
}>();

const emit = defineEmits<{
  (e: 'select-node', arcId: string, nodeId: string): void;
  (e: 'set-focus', arcId: string): void;
  (e: 'select-arc', arcId: string): void;
  (e: 'open-trigger', arcId: string): void;
  (e: 'activate', arcId: string): void;
  (e: 'confirm', arcId: string): void;
  (e: 'reject', arcId: string): void;
  (e: 'reorder-lane', arcId: string, toIndex: number): void;
  (e: 'reorder-node', arcId: string, nodeId: string, toIndex: number): void;
  (e: 'schedule-at', arcId: string, round: number): void;
  (e: 'update:axis', mode: AxisMode): void;
}>();

// ─── Layout + axis ───
const layout = computed(() => {
  const l = layoutThreads(props.arcs, props.focusArcId, props.currentRound);
  // `layoutThreads` builds fresh, call-local lane objects every time, so
  // annotating them here (before the computed returns) aliases no shared state.
  // Why a scheduled thread is still waiting (for the head's hint).
  for (const lane of l.lanes) {
    if (lane.arc.status !== 'scheduled') continue;
    const v = evaluateThreadActivation(lane.arc.activation, { arcs: props.arcs, currentRound: props.currentRound });
    lane.waitingOn = v.satisfied ? undefined : v.reason;
  }
  return l;
});
const samples = computed(() => collectDateSamples(props.arcs));
const axisModel = computed(() => buildAxis(props.axis, layout.value, {
  pxPerRound: PX_ROUND,
  pxPerDay: PX_DAY,
  samples: samples.value,
  currentRound: props.currentRound,
  labels: {
    stamp: (st) => t('plot.scheduler.dateTick', { month: st.month ?? '?', day: st.day ?? '?' }),
    day: (n) => t('plot.scheduler.dayTick', { n }),
  },
}));
const activeCount = computed(() => props.arcs.filter(a => a.status === 'active').length);
const canActivateMore = computed(() => activeCount.value < props.maxActiveThreads);

function laneTop(idx: number): number {
  let y = 0;
  for (let i = 0; i < idx; i++) y += isFinished(layout.value.lanes[i]) ? DONE_H : LANE_H;
  return y;
}
function isFinished(l: LayoutLane): boolean { return l.arc.status === 'completed' || l.arc.status === 'abandoned'; }
const lanesHeight = computed(() => layout.value.lanes.reduce((h, l) => h + (isFinished(l) ? DONE_H : LANE_H), 0));

/** Trigger links: from the source block's right edge to the scheduled lane's first block. */
const links = computed(() => {
  const out: Array<{ d: string; x1: number; y1: number; x2: number; y2: number }> = [];
  const x = axisModel.value.x;
  layout.value.lanes.forEach((lane, li) => {
    const link = lane.link;
    if (!link || lane.nodes.length === 0) return;
    const srcLi = layout.value.lanes.findIndex(l => l.arc.id === link.fromArcId);
    const src = layout.value.lanes[srcLi]?.nodes.find(n => n.node.id === link.fromNodeId);
    if (!src || srcLi < 0) return;
    const x1 = x(src.end) - 4;
    const y1 = laneTop(srcLi) + (isFinished(layout.value.lanes[srcLi]) ? DONE_H / 2 : LANE_H / 2);
    const x2 = x(lane.nodes[0].start);
    const y2 = laneTop(li) + LANE_H / 2;
    const mx = x1 + Math.max(18, (x2 - x1) / 2);
    out.push({ d: `M${x1},${y1} C${mx},${y1} ${x2 - 18},${y2} ${x2},${y2}`, x1, y1, x2, y2 });
  });
  return out;
});

const nowX = computed(() => axisModel.value.x(props.currentRound));

// Keep "now" around 45% of the viewport on first render / axis change.
const trackEl = ref<HTMLElement | null>(null);
function scrollToNow(): void {
  const el = trackEl.value;
  if (!el) return;
  el.scrollLeft = Math.max(0, nowX.value - el.clientWidth * 0.45);
}
watch(() => [props.axis, trackEl.value], () => requestAnimationFrame(scrollToNow), { immediate: true });

// ─── Gate popover (critical node waiting for confirmation) ───
// Viewport-fixed + teleported (as in the approved demo): the track clips
// vertically (`overflow-y: hidden`), so an in-flow popover on a lower lane
// would lose its buttons. Positioned from the badge's bounding rect, flipped
// upward when it would run off the bottom, and closed on scroll/outside/Esc.
const GATE_W = 280;
const GATE_H = 150;
const gate = ref<{ arcId: string; nodeId: string; left: number; top: number } | null>(null);
function openGate(lane: LayoutLane, nodeId: string, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(8, Math.min(vw - GATE_W - 8, r.left - GATE_W / 2 + r.width / 2));
  const top = r.bottom + 8 + GATE_H > vh ? Math.max(8, r.top - 8 - GATE_H) : r.bottom + 8;
  gate.value = { arcId: lane.arc.id, nodeId, left, top };
}
function closeGate(): void { gate.value = null; }
function onGateOutside(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  if (el?.closest('[data-testid="plot-sched-gate-pop"]') || el?.closest('[data-testid="plot-sched-gate"]')) return;
  closeGate();
}
function onGateKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeGate(); }
watch(gate, (g, _old, onCleanup) => {
  if (!g) return;
  document.addEventListener('click', onGateOutside, true);
  window.addEventListener('keydown', onGateKey);
  trackEl.value?.addEventListener('scroll', closeGate, { passive: true });
  onCleanup(() => {
    document.removeEventListener('click', onGateOutside, true);
    window.removeEventListener('keydown', onGateKey);
    trackEl.value?.removeEventListener('scroll', closeGate);
  });
});
const gateInfo = computed(() => {
  const open = gate.value;
  if (!open) return null;
  const g = props.pendingConfirmations.find(c => c.arcId === open.arcId);
  const arc = props.arcs.find(a => a.id === open.arcId);
  const node = arc?.nodes.find(n => n.id === open.nodeId);
  return g && arc && node ? { g, arc, node } : null;
});
watch(() => props.pendingConfirmations, () => { if (gate.value && !gateInfo.value) gate.value = null; });

function onHeadClick(lane: LayoutLane): void {
  if (lane.arc.status === 'active') emit('set-focus', lane.arc.id);
  else emit('select-arc', lane.arc.id);
}

// ─── Lane reorder (vertical pointer drag on the head handle; arrow keys as fallback) ───
const dragArcId = ref<string | null>(null);
const dragActivated = ref(false);
let dragFrom = -1;
let activePointerId: number | null = null;
let startY = 0;
const dropIndex = ref<number | null>(null);

function onHandleDown(e: PointerEvent, idx: number): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (dragArcId.value !== null) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  activePointerId = e.pointerId;
  dragArcId.value = layout.value.lanes[idx].arc.id;
  dragFrom = idx;
  dragActivated.value = false;
  startY = e.clientY;
  window.addEventListener('keydown', onDragEscape);
}
function onHandleMove(e: PointerEvent): void {
  if (dragArcId.value === null || e.pointerId !== activePointerId) return;
  if (!dragActivated.value && Math.abs(e.clientY - startY) < 5) return;
  dragActivated.value = true;
  const rows = Array.from((trackEl.value ?? document).querySelectorAll<HTMLElement>('[data-plot-lane]'));
  let k = 0;
  rows.forEach((el, i) => { if (i === dragFrom) return; const r = el.getBoundingClientRect(); if (e.clientY > r.top + r.height / 2) k++; });
  dropIndex.value = k === dragFrom ? null : k;
}
function onHandleUp(e: PointerEvent): void {
  if (dragArcId.value === null || e.pointerId !== activePointerId) return;
  if (dragActivated.value && dropIndex.value !== null) emit('reorder-lane', dragArcId.value, dropIndex.value);
  resetDrag();
}
function onHandleCancel(e: PointerEvent): void { if (e.pointerId === activePointerId) resetDrag(); }
function onDragEscape(e: KeyboardEvent): void { if (e.key === 'Escape') resetDrag(); }
function resetDrag(): void {
  dragArcId.value = null;
  dragActivated.value = false;
  dropIndex.value = null;
  activePointerId = null;
  window.removeEventListener('keydown', onDragEscape);
}
function onHandleKey(e: KeyboardEvent, idx: number): void {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const target = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
  if (target < 0 || target >= layout.value.lanes.length) return;
  emit('reorder-lane', layout.value.lanes[idx].arc.id, target);
}
onBeforeUnmount(resetDrag);
</script>

<template>
  <div class="sched" data-testid="plot-scheduler">
    <div class="sched__bar">
      <div class="seg" role="group">
        <button :class="['seg__btn', { 'seg__btn--on': axis === 'round' }]" type="button" data-testid="plot-axis-round" @click="emit('update:axis', 'round')">{{ $t('plot.scheduler.axisRound') }}</button>
        <button :class="['seg__btn', { 'seg__btn--on': axis === 'date' }]" type="button" data-testid="plot-axis-date" @click="emit('update:axis', 'date')">{{ $t('plot.scheduler.axisDate') }}</button>
      </div>
      <span v-if="axisModel.degraded" class="sched__hint">{{ $t('plot.scheduler.noDateData') }}</span>
    </div>

    <div ref="trackEl" class="sched__track" data-testid="plot-scheduler-track">
      <!-- Ruler -->
      <div class="ruler" :style="{ width: (HEAD_W + axisModel.width) + 'px', height: RULER_H + 'px' }">
        <div class="ruler__head" :style="{ width: HEAD_W + 'px' }">{{ $t('plot.scheduler.laneHeader') }}</div>
        <div class="ruler__ticks" :style="{ left: HEAD_W + 'px' }">
          <div v-for="tick in axisModel.ticks" :key="tick.x" :class="['tick', { 'tick--major': tick.major }]" :style="{ left: tick.x + 'px' }">
            <span v-if="tick.major" class="tick__label">{{ tick.label }}</span>
            <i v-if="tick.sub" class="tick__sub">{{ tick.sub }}</i>
            <i v-else-if="tick.estimated" class="tick__sub tick__sub--est">{{ $t('plot.scheduler.estimated') }}</i>
          </div>
          <div class="now now--ruler" :style="{ left: nowX + 'px' }"><span class="now__label">{{ $t('plot.scheduler.now') }}</span></div>
        </div>
      </div>

      <!-- Lanes -->
      <div class="lanes" :style="{ width: (HEAD_W + axisModel.width) + 'px', minHeight: lanesHeight + 'px', backgroundPositionY: lanesHeight + 'px' }">
        <div v-if="layout.lanes.length === 0" class="sched__empty">{{ $t('plot.scheduler.empty') }}</div>
        <!-- TransitionGroup: rows slide to their new order after a lane drag / focus switch (FLIP `lane-move`). -->
        <TransitionGroup name="lane" tag="div" class="lanes__rows">
        <PlotThreadLane
          v-for="(lane, idx) in layout.lanes"
          :key="lane.arc.id"
          :lane="lane"
          :axis="axisModel"
          :arcs="arcs"
          :is-focus="lane.arc.id === focusArcId"
          :current-round="currentRound"
          :gate="pendingConfirmations.find(c => c.arcId === lane.arc.id) ?? null"
          :head-width="HEAD_W"
          :can-activate="canActivateMore"
          :generating="generatingArcId === lane.arc.id"
          :dragging="dragActivated && dragArcId === lane.arc.id"
          :class="{ 'lane-drop-before': dropIndex !== null && dropIndex === idx && idx < dragFrom, 'lane-drop-after': dropIndex !== null && dropIndex === idx && idx > dragFrom }"
          @select-node="emit('select-node', lane.arc.id, $event)"
          @head-click="onHeadClick(lane)"
          @gate="(nodeId: string, anchor: HTMLElement) => openGate(lane, nodeId, anchor)"
          @open-trigger="emit('open-trigger', lane.arc.id)"
          @activate="emit('activate', lane.arc.id)"
          @handle-pointerdown="onHandleDown($event, idx)"
          @handle-pointermove="onHandleMove"
          @handle-pointerup="onHandleUp"
          @handle-pointercancel="onHandleCancel"
          @handle-keydown="onHandleKey($event, idx)"
          @reorder-node="(nodeId: string, toIndex: number) => emit('reorder-node', lane.arc.id, nodeId, toIndex)"
          @schedule-at="(round: number) => emit('schedule-at', lane.arc.id, round)"
        />
        </TransitionGroup>
        <!-- now line across lanes + trigger links (both offset by the sticky head width) -->
        <div class="now" :style="{ left: (HEAD_W + nowX) + 'px' }" />
        <svg class="links" :style="{ left: HEAD_W + 'px' }" :width="axisModel.width" :height="lanesHeight" aria-hidden="true">
          <g v-for="(lk, i) in links" :key="i">
            <path :d="lk.d" />
            <circle :cx="lk.x1" :cy="lk.y1" r="2.5" />
            <polygon class="links__arrow" :points="`${lk.x2},${lk.y2} ${lk.x2 - 7},${lk.y2 - 4} ${lk.x2 - 7},${lk.y2 + 4}`" />
          </g>
        </svg>

      </div>
    </div>

    <!-- Confirmation gate popover — teleported so the track's overflow clipping cannot hide it -->
    <Teleport to="body">
      <div v-if="gate && gateInfo" class="gate" :style="{ left: gate.left + 'px', top: gate.top + 'px' }" role="dialog" :aria-label="gateInfo.node.title" data-testid="plot-sched-gate-pop">
        <p class="gate__title">{{ gateInfo.node.title }}</p>
        <p class="gate__thread">{{ $t('plot.confirm.threadLabel', { title: gateInfo.arc.title }) }}</p>
        <p class="gate__evidence">{{ gateInfo.g.evidence }}</p>
        <div class="gate__actions">
          <button class="gate__btn gate__btn--ok" type="button" @click="emit('confirm', gateInfo.arc.id); closeGate()">{{ $t('plot.confirm.title') }}</button>
          <button class="gate__btn" type="button" @click="emit('reject', gateInfo.arc.id); closeGate()">{{ $t('plot.confirm.notYet') }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sched {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  /* Fill the panel: the track grows to the available height instead of hugging its rows. */
  flex: 1 1 auto;
  min-height: 0;
}
.sched__bar { display: flex; align-items: center; gap: 10px; }
.sched__hint { font-size: var(--font-size-xs, 12px); color: var(--color-text-muted, #888); }
.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: rgba(255, 255, 255, 0.025);
  border-radius: 10px;
}
.seg__btn {
  border: none;
  background: transparent;
  color: var(--color-text-muted, #888);
  padding: 4px 10px;
  font-size: var(--font-size-xs, 12px);
  border-radius: 8px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.2s var(--ease-out, ease-out);
}
.seg__btn--on {
  color: var(--color-text, #e0e0e6);
  background: var(--glass-bg, rgba(255, 255, 255, 0.04));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

/* Horizontal scrolling ONLY inside the track — the page body must never scroll sideways. */
.sched__track {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 320px;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  /* Many threads scroll vertically inside the track (the ruler stays sticky). */
  overflow-y: auto;
  border-radius: var(--radius-md, 8px);
  background: oklch(0.125 0.006 95);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.12) transparent;
  --lane-h: 76px;
  --lane-h-done: 40px;
}
.sched__track::-webkit-scrollbar { height: 6px; width: 6px; }
.sched__track::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.12); border-radius: 3px; }

.ruler {
  position: sticky;
  top: 0;
  flex: none;
  display: flex;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  z-index: 6;
  background: oklch(0.125 0.006 95);
}
.ruler__head {
  position: sticky;
  left: 0;
  z-index: 7;
  flex: none;
  display: flex;
  align-items: flex-end;
  padding: 0 12px 6px;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-text-muted, #888);
  background: oklch(0.125 0.006 95);
  border-right: 1px solid rgba(255, 255, 255, 0.05);
}
.ruler__ticks { position: absolute; top: 0; bottom: 0; right: 0; }
.tick { position: absolute; top: 0; height: 100%; border-left: 1px solid rgba(255, 255, 255, 0.04); }
.tick--major { border-left-color: rgba(255, 255, 255, 0.09); }
.tick__label { position: absolute; top: 6px; left: 5px; font-family: var(--font-mono, monospace); font-size: 10px; color: var(--color-text-muted, #888); white-space: nowrap; }
.tick__sub { position: absolute; top: 25px; left: 5px; font-style: normal; font-family: var(--font-serif-cjk, serif); font-size: 10px; color: oklch(0.5 0.03 75); white-space: nowrap; }
.tick__sub--est { opacity: 0.5; }

.lanes {
  position: relative;
  flex: 1 0 auto;
  /* Empty space below the real rows keeps the row rhythm as faint lines (breathing, not void).
     `background-position-y` is bound to the rows' total height so the grid starts where they end. */
  background-image: repeating-linear-gradient(
    to bottom,
    transparent 0 calc(var(--lane-h) - 1px),
    rgba(255, 255, 255, 0.025) calc(var(--lane-h) - 1px) var(--lane-h)
  );
}
.sched__empty { padding: 24px 16px; font-size: var(--font-size-sm, 13px); color: var(--color-text-muted, #888); }

.now {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in oklch, var(--color-amber-300, #e2bd7a) 55%, transparent);
  z-index: 2;
  pointer-events: none;
}
.now--ruler::before {
  content: '';
  position: absolute;
  top: 0;
  left: -5px;
  border: 5px solid transparent;
  border-top: 6px solid var(--color-amber-300, #e2bd7a);
}
.now__label { position: absolute; top: 8px; left: 6px; font-size: 10px; font-family: var(--font-serif-cjk, serif); color: var(--color-amber-300, #e2bd7a); }

.links { position: absolute; top: 0; pointer-events: none; z-index: 1; overflow: visible; }
.links path { fill: none; stroke: color-mix(in oklch, var(--color-sage-400, #8cb88c) 55%, transparent); stroke-width: 1.2; stroke-dasharray: 4 3; }
.links circle { fill: var(--color-sage-400, #8cb88c); }
.links__arrow { fill: color-mix(in oklch, var(--color-sage-400, #8cb88c) 80%, transparent); }

.lanes__rows { position: relative; }
.lane-move { transition: transform 0.38s var(--ease-out, ease-out); }
@media (prefers-reduced-motion: reduce) { .lane-move { transition: none; } }

.lane-drop-before { box-shadow: inset 0 2px 0 var(--color-sage-400, #8cb88c); }
.lane-drop-after { box-shadow: inset 0 -2px 0 var(--color-sage-400, #8cb88c); }

.gate {
  position: fixed;
  z-index: var(--z-floating, 9100);
  width: 280px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--glass-bg, rgba(255, 255, 255, 0.04));
  backdrop-filter: var(--glass-blur, blur(24px));
  -webkit-backdrop-filter: var(--glass-blur, blur(24px));
  box-shadow: var(--glass-shadow, 0 12px 40px rgba(0, 0, 0, 0.4));
  font-size: var(--font-size-xs, 12px);
  animation: gate-fade 0.18s var(--ease-out, ease-out);
}
@keyframes gate-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.gate__title { margin: 0 0 2px; font-family: var(--font-serif-cjk, serif); font-size: 0.95rem; color: var(--color-text, #e0e0e6); }
.gate__thread { margin: 0 0 6px; font-family: var(--font-mono, monospace); font-size: 10px; color: var(--color-text-muted, #888); }
.gate__evidence { margin: 0 0 8px; color: var(--color-text-secondary, #aaa); line-height: 1.5; }
.gate__actions { display: flex; gap: 6px; }
.gate__btn {
  border: none;
  border-radius: 7px;
  padding: 6px 12px;
  font-size: var(--font-size-xs, 12px);
  cursor: pointer;
  font-family: inherit;
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text-secondary, #aaa);
}
.gate__btn--ok { background: color-mix(in oklch, var(--color-sage-400, #8cb88c) 22%, transparent); color: var(--color-sage-300, #a9cca9); }
</style>
