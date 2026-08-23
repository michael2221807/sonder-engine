<script setup lang="ts">
// Design: docs/design/plot-parallel-threads-scheduler.md §5.1-5.3 (lane head + blocks + block drag)
// App doc: docs/user-guide/pages/game-plot.md §时间线视图
import { computed, ref, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import AgaLoader from '@/ui/components/shared/AgaLoader.vue';
import PlotNodeBlock from './PlotNodeBlock.vue';
import type { LayoutLane, LayoutNode, SchedulerAxis } from './scheduler-layout';
import type { PendingNodeConfirmation, PlotArc } from '@/engine/plot/types';

const { t } = useI18n();

const props = defineProps<{
  lane: LayoutLane;
  axis: SchedulerAxis;
  /** All arcs (to name trigger targets in the head). */
  arcs: PlotArc[];
  isFocus: boolean;
  currentRound: number;
  gate: PendingNodeConfirmation | null;
  /** Head width in px (sticky column). */
  headWidth: number;
  canActivate: boolean;
  /** Drag state from the parent (lane reorder). */
  dragging: boolean;
  /** The AI is still decomposing this thread's outline into nodes. */
  generating?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select-node', nodeId: string): void;
  (e: 'head-click'): void;
  (e: 'gate', nodeId: string, anchor: HTMLElement): void;
  (e: 'open-trigger'): void;
  (e: 'activate'): void;
  (e: 'handle-pointerdown', ev: PointerEvent): void;
  (e: 'handle-pointermove', ev: PointerEvent): void;
  (e: 'handle-pointerup', ev: PointerEvent): void;
  (e: 'handle-pointercancel', ev: PointerEvent): void;
  (e: 'handle-keydown', ev: KeyboardEvent): void;
  /** A pending block was dragged to a new position among its siblings (store index semantics). */
  (e: 'reorder-node', nodeId: string, toIndex: number): void;
  /** The first block of a draft/scheduled thread was dragged to a round → `round_reached` trigger. */
  (e: 'schedule-at', round: number): void;
}>();

const arc = computed(() => props.lane.arc);
const finished = computed(() => arc.value.status === 'completed' || arc.value.status === 'abandoned');
const inert = computed(() => arc.value.status === 'scheduled' || arc.value.status === 'draft');
const dotClass = computed(() => `lane-head__dot--${arc.value.status}`);

/** Sub-line under the title: gauges for active, waiting reason for scheduled, status for others. */
const subline = computed(() => {
  const a = arc.value;
  if (a.status === 'scheduled') {
    if (props.lane.waitingOn === 'target_abandoned') return t('plot.scheduler.targetAbandoned');
    const trig = a.activation?.triggers[0];
    if (!trig) return t('plot.scheduler.status.scheduled');
    if (trig.type === 'round_reached') return t('plot.scheduler.waitingRound', { round: trig.round });
    if (trig.type === 'gauge') return t('plot.scheduler.waitingGauge');
    const target = props.arcs.find(x => x.id === trig.arcId);
    const nodeTitle = trig.type === 'node_completed' ? target?.nodes.find(n => n.id === trig.nodeId)?.title : undefined;
    const label = target ? (nodeTitle ? `${target.title}·${nodeTitle}` : target.title) : '?';
    return t('plot.scheduler.waitingAfter', { target: label });
  }
  if (a.status === 'draft') return t('plot.scheduler.status.draft');
  if (a.status === 'abandoned') return t('plot.scheduler.status.abandoned');
  return '';
});

function gaugePct(g: PlotArc['gauges'][number]): number {
  const range = g.max - g.min;
  return range > 0 ? Math.round(((g.current - g.min) / range) * 100) : 0;
}
function gaugeText(g: PlotArc['gauges'][number]): string {
  return g.unit === '%' ? `${gaugePct(g)}%` : `${g.current}${g.unit}`;
}

function tiersFor(ln: LayoutNode): Array<{ left: number; hit: boolean }> {
  const n = ln.node;
  if (n.status !== 'active' || n.activatedAtRound == null) return [];
  const elapsed = props.currentRound - n.activatedAtRound;
  const x0 = props.axis.x(ln.start);
  return n.opportunityTiers.map(tier => ({
    left: props.axis.x(n.activatedAtRound! + tier.afterRounds) - x0,
    hit: elapsed >= tier.afterRounds,
  }));
}

/** Explicit accessible name — nested buttons must not bleed into the head's label. */
const headAria = computed(() => {
  const title = arc.value.title || t('plot.arc.untitled');
  return arc.value.status === 'active' ? `${title} — ${t('plot.scheduler.focusTip')}` : title;
});

const anchorLeft = computed(() => {
  const first = props.lane.nodes[0];
  return first ? props.axis.x(first.start) - 24 : 0;
});

function blockLeft(ln: LayoutNode): number { return props.axis.x(ln.start); }
function blockWidth(ln: LayoutNode): number { return Math.max(28, props.axis.x(ln.end) - props.axis.x(ln.start) - 4); }

// ─── Block drag (design §5.3) ───
// Two roles, decided by where the block sits:
//   reorder  — a pending node in any live lane moves among its pending siblings
//              (the store refuses moves into the completed/active prefix);
//   schedule — the FIRST block of a draft/scheduled thread is dragged to a round
//              → the thread gets (or rewrites) a `round_reached` trigger.
type DragRole = 'reorder' | 'schedule';
const floor = computed(() => arc.value.nodes.reduce((m, n, i) => (n.status !== 'pending' ? i : m), -1));
function roleFor(ln: LayoutNode, idx: number): DragRole | undefined {
  if (finished.value || ln.node.status !== 'pending') return undefined;
  if (inert.value && idx === 0) return 'schedule';
  return 'reorder';
}

const dragNodeId = ref<string | null>(null);
const dragActivated = ref(false);
const dragDx = ref(0);
const dropIndex = ref<number | null>(null);
const dropRound = ref<number | null>(null);
let dragIdx = -1;
let dragRole: DragRole = 'reorder';
let startX = 0;
let activePointerId: number | null = null;

/** Pixel x (track space) of the insertion line for a reorder drop. */
const dropX = computed<number | null>(() => {
  if (dropIndex.value === null || dragIdx < 0) return null;
  const others = props.lane.nodes.filter((_, i) => i !== dragIdx);
  const k = dropIndex.value;
  if (k < others.length) return props.axis.x(others[k].start) - 3;
  const last = others[others.length - 1];
  return last ? props.axis.x(last.end) - 3 : props.axis.x(props.currentRound + 1);
});
const dropRoundX = computed<number | null>(() => (dropRound.value === null ? null : props.axis.x(dropRound.value)));

function onBlockDown(e: PointerEvent, ln: LayoutNode, idx: number): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (dragNodeId.value !== null) return;
  const role = roleFor(ln, idx);
  if (!role) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  activePointerId = e.pointerId;
  dragNodeId.value = ln.node.id;
  dragIdx = idx;
  dragRole = role;
  dragActivated.value = false;
  dragDx.value = 0;
  startX = e.clientX;
  window.addEventListener('keydown', onDragEscape);
}
function onBlockMove(e: PointerEvent): void {
  if (dragNodeId.value === null || e.pointerId !== activePointerId) return;
  const dx = e.clientX - startX;
  // Touch needs a wider slop than a mouse so a slightly diagonal vertical scroll
  // on a block doesn't turn into a reorder.
  if (!dragActivated.value && Math.abs(dx) < (e.pointerType === 'touch' ? 12 : 5)) return;
  dragActivated.value = true;
  dragDx.value = dx;
  const ln = props.lane.nodes[dragIdx];
  if (!ln) return;
  if (dragRole === 'schedule') {
    dropRound.value = Math.max(props.currentRound + 1, props.axis.roundAt(props.axis.x(ln.start) + dx));
    return;
  }
  // Reorder: count the OTHER blocks whose centre lies left of the dragged block's centre.
  const centre = props.axis.x(ln.start) + dx + blockWidth(ln) / 2;
  let k = 0;
  props.lane.nodes.forEach((o, i) => {
    if (i === dragIdx) return;
    const oc = (props.axis.x(o.start) + props.axis.x(o.end)) / 2;
    if (centre > oc) k++;
  });
  dropIndex.value = (k === dragIdx || k <= floor.value) ? null : k;
}
function onBlockUp(e: PointerEvent): void {
  if (dragNodeId.value === null || e.pointerId !== activePointerId) return;
  if (dragActivated.value) {
    if (dragRole === 'schedule' && dropRound.value !== null) emit('schedule-at', dropRound.value);
    else if (dragRole === 'reorder' && dropIndex.value !== null) emit('reorder-node', dragNodeId.value, dropIndex.value);
  }
  resetDrag();
}
function onBlockCancel(e: PointerEvent): void { if (e.pointerId === activePointerId) resetDrag(); }
function onDragEscape(e: KeyboardEvent): void { if (e.key === 'Escape') resetDrag(); }
function resetDrag(): void {
  dragNodeId.value = null;
  dragActivated.value = false;
  dragDx.value = 0;
  dropIndex.value = null;
  dropRound.value = null;
  dragIdx = -1;
  activePointerId = null;
  window.removeEventListener('keydown', onDragEscape);
}
onBeforeUnmount(resetDrag);

/** Keyboard equivalent of the drag (←/→ on a focused block). */
function onBlockMoveKey(ln: LayoutNode, idx: number, dir: -1 | 1): void {
  const role = roleFor(ln, idx);
  if (role === 'schedule') {
    const current = arc.value.activation?.triggers.find(tr => tr.type === 'round_reached');
    const base = current?.type === 'round_reached' ? current.round : ln.start;
    emit('schedule-at', Math.max(props.currentRound + 1, base + dir));
  } else if (role === 'reorder') {
    const to = idx + dir;
    if (to <= floor.value || to >= arc.value.nodes.length) return;
    emit('reorder-node', ln.node.id, to);
  }
}
</script>

<template>
  <div
    :class="['lane', { 'lane--finished': finished, 'lane--inert': inert, 'lane--dim': arc.status === 'active' && !isFocus, 'lane--dragging': dragging, 'lane--block-drag': dragActivated }]"
    :data-arc-id="arc.id"
    data-plot-lane
  >
    <!-- Sticky head -->
    <div
      :class="['lane-head', { 'lane-head--focus': isFocus }]"
      :style="{ width: headWidth + 'px' }"
      role="button"
      tabindex="0"
      :aria-label="headAria"
      data-testid="plot-sched-lane-head"
      @click="emit('head-click')"
      @keydown.enter.prevent="emit('head-click')"
    >
      <Tooltip :text="$t('plot.scheduler.laneDragAria')" interactive fixed class="lane-head__drag-tt">
        <button
          class="lane-head__drag"
          type="button"
          :aria-label="$t('plot.scheduler.laneDragAria')"
          @click.stop
          @pointerdown="emit('handle-pointerdown', $event)"
          @pointermove="emit('handle-pointermove', $event)"
          @pointerup="emit('handle-pointerup', $event)"
          @pointercancel="emit('handle-pointercancel', $event)"
          @keydown="emit('handle-keydown', $event)"
        >⋮⋮</button>
      </Tooltip>
      <Tooltip :text="arc.status === 'active' ? $t('plot.scheduler.focusTip') : $t('plot.scheduler.focusOnlyActive')" interactive fixed class="lane-head__title-tt">
        <div class="lane-head__title">
          <span :class="['lane-head__dot', dotClass]" />
          <span class="lane-head__text">{{ arc.title || $t('plot.arc.untitled') }}</span>
        </div>
      </Tooltip>
      <div v-if="generating" class="lane-head__sub lane-head__sub--gen" data-testid="plot-sched-generating">
        <AgaLoader size="sm" />{{ $t('plot.scheduler.generating') }}
      </div>
      <div v-else-if="arc.status === 'active' && arc.gauges.length" class="lane-head__gauges">
        <span v-for="g in arc.gauges" :key="g.id" class="gmini">
          <b :style="{ '--v': gaugePct(g) + '%', '--c': g.color ?? 'var(--color-sage-600)' }" />{{ g.name }}{{ gaugeText(g) }}
        </span>
      </div>
      <div v-else-if="subline" class="lane-head__sub">{{ subline }}</div>
      <Tooltip v-if="inert && arc.nodes.length > 0" :text="canActivate ? $t('plot.scheduler.activate') : $t('plot.arc.activeBlocked')" interactive fixed class="lane-head__act-tt">
        <button
          class="lane-head__act"
          type="button"
          :disabled="!canActivate"
          data-testid="plot-sched-activate"
          @click.stop="emit('activate')"
        >▶</button>
      </Tooltip>
    </div>

    <!-- Track -->
    <div class="lane-track" :style="{ width: axis.width + 'px' }">
      <Tooltip v-if="inert" :text="$t('plot.scheduler.setTrigger')" interactive fixed class="lane-anchor-tt" :style="{ left: anchorLeft + 'px' }">
        <button class="lane-anchor" type="button" data-testid="plot-sched-anchor" @click.stop="emit('open-trigger')">⇠</button>
      </Tooltip>
      <!-- Decomposition in flight: a breathing placeholder where the nodes will land. -->
      <div v-if="generating && lane.nodes.length === 0" class="lane-gen" :style="{ left: axis.x(currentRound + 1) + 'px' }" aria-hidden="true" />
      <PlotNodeBlock
        v-for="(ln, idx) in lane.nodes"
        :key="ln.node.id"
        :layout-node="ln"
        :left="blockLeft(ln)"
        :width="blockWidth(ln)"
        :tiers="tiersFor(ln)"
        :gated="!!gate && gate.nodeId === ln.node.id"
        :compact="finished"
        :draggable="!!roleFor(ln, idx)"
        :drag-role="roleFor(ln, idx)"
        :dragging="dragActivated && dragNodeId === ln.node.id"
        :drag-dx="dragDx"
        :hint-off="dragActivated"
        @select="emit('select-node', ln.node.id)"
        @gate="emit('gate', ln.node.id, $event)"
        @drag-pointerdown="onBlockDown($event, ln, idx)"
        @drag-pointermove="onBlockMove"
        @drag-pointerup="onBlockUp"
        @drag-pointercancel="onBlockCancel"
        @move="onBlockMoveKey(ln, idx, $event)"
      />
      <!-- Drop cues -->
      <div v-if="dropX !== null" class="lane-drop" :style="{ left: dropX + 'px' }" data-testid="plot-sched-drop" />
      <div v-if="dropRoundX !== null" class="lane-drop lane-drop--round" :style="{ left: dropRoundX + 'px' }" data-testid="plot-sched-drop-round">
        <span class="lane-drop__chip">{{ $t('plot.scheduler.dropRound', { round: dropRound }) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lane {
  display: flex;
  height: var(--lane-h, 76px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.035);
  transition: opacity 0.3s;
  position: relative;
}
.lane--finished { height: var(--lane-h-done, 40px); }
.lane--dim { opacity: 0.62; }
.lane--inert { opacity: 0.55; }
.lane--dragging { opacity: 1; z-index: 5; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); background: var(--color-surface-elevated, #2a2927); }
.lane--block-drag { user-select: none; -webkit-user-select: none; opacity: 1; }

.lane-head {
  position: sticky;
  left: 0;
  z-index: 4;
  flex: none;
  height: 100%;
  padding: 8px 12px 8px 14px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  background: oklch(0.125 0.006 95);
  border-right: 1px solid rgba(255, 255, 255, 0.05);
  transition: background 0.2s;
}
.lane-head:hover, .lane-head:focus-visible { background: oklch(0.15 0.006 95); outline: none; }
.lane--finished .lane-head { flex-direction: row; align-items: center; gap: 8px; padding-top: 0; padding-bottom: 0; }
.lane-head--focus::before {
  content: '';
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 2px;
  background: var(--color-sage-400, #8cb88c);
  box-shadow: 0 0 10px color-mix(in oklch, var(--color-sage-400, #8cb88c) 50%, transparent);
}
.lane-head__title-tt { min-width: 0; display: block; }
.lane-head__title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-family: var(--font-serif-cjk, serif);
  font-size: 0.95rem;
  color: var(--color-text-secondary, #aaa);
  min-width: 0;
}
.lane-head--focus .lane-head__title { color: var(--color-text, #e0e0e6); }
.lane--finished .lane-head__title { font-size: 0.78rem; color: var(--color-text-muted, #888); }
.lane-head__text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane-head__dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.lane-head__dot--active { background: var(--color-sage-400, #8cb88c); box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400, #8cb88c) 60%, transparent); }
.lane-head__dot--scheduled { border: 1.5px dashed var(--color-text-muted, #888); }
.lane-head__dot--draft { border: 1.5px solid var(--color-text-muted, #888); }
.lane-head__dot--completed { background: var(--color-sage-700, #5e7a5e); }
.lane-head__dot--abandoned { background: var(--color-danger, #b85c4a); opacity: 0.7; }
.lane-head__gauges { display: flex; gap: 6px; overflow: hidden; }
.gmini {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  flex: none;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-muted, #888);
}
.gmini b {
  display: inline-block;
  width: 34px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  position: relative;
  overflow: hidden;
}
.gmini b::after { content: ''; position: absolute; inset: 0; width: var(--v); background: var(--c); }
.lane-head__sub { font-size: 10px; font-family: var(--font-mono, monospace); color: var(--color-text-muted, #888); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lane-head__sub--gen { display: flex; align-items: center; gap: 6px; color: var(--color-sage-300, #a9cca9); font-family: var(--font-serif-cjk, serif); font-size: 11px; }
.lane-head__drag-tt { position: absolute; right: 28px; top: 50%; transform: translateY(-50%); }
.lane-head__drag {
  border: none;
  background: transparent;
  color: var(--color-text-muted, #888);
  opacity: 0;
  font-size: 0.8rem;
  letter-spacing: -2px;
  cursor: grab;
  padding: 4px;
  touch-action: none;
  transition: opacity 0.2s;
}
.lane-head:hover .lane-head__drag, .lane-head__drag:focus-visible { opacity: 0.6; }
.lane-head__act-tt { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); }
.lane-head__act {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: none;
  background: color-mix(in oklch, var(--color-sage-400, #8cb88c) 18%, transparent);
  color: var(--color-sage-300, #a9cca9);
  font-size: 9px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.2s;
}
.lane-head:hover .lane-head__act, .lane-head__act:focus-visible { opacity: 1; }
.lane-head__act:disabled { opacity: 0.35; cursor: not-allowed; }

.lane-track { position: relative; flex: none; height: 100%; }
.lane-anchor-tt { position: absolute; top: 20px; height: 36px; }
.lane-anchor {
  width: 22px;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--color-text-muted, #888);
  opacity: 0.6;
  cursor: pointer;
  font-size: 0.9rem;
  transition: opacity 0.2s, color 0.2s;
}
.lane-anchor:hover { opacity: 1; color: var(--color-sage-400, #8cb88c); }

.lane-gen {
  position: absolute;
  top: 18px;
  height: 40px;
  width: 220px;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), color-mix(in oklch, var(--color-sage-400, #8cb88c) 14%, transparent), rgba(255, 255, 255, 0.03));
  background-size: 200% 100%;
  animation: lane-gen-sweep 1.8s ease-in-out infinite;
}
@keyframes lane-gen-sweep { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

.lane-drop {
  position: absolute;
  top: 12px;
  bottom: 12px;
  width: 2px;
  border-radius: 1px;
  background: var(--color-sage-400, #8cb88c);
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400, #8cb88c) 60%, transparent);
  pointer-events: none;
  z-index: 7;
}
.lane-drop--round { background: var(--color-amber-300, #e2bd7a); box-shadow: 0 0 8px color-mix(in oklch, var(--color-amber-300, #e2bd7a) 60%, transparent); }
.lane-drop__chip {
  position: absolute;
  top: -4px;
  left: 6px;
  white-space: nowrap;
  font-size: 10px;
  font-family: var(--font-serif-cjk, serif);
  color: var(--color-amber-100, #f5ecd9);
  background: rgba(25, 24, 22, 0.92);
  padding: 2px 7px;
  border-radius: 5px;
}

@media (prefers-reduced-motion: reduce) { .lane-gen { animation: none; } }

/* Phones: the head is ~26% of the viewport (PlotScheduler HEAD_W). Compact title,
   one gauge only, no lane-reorder handle (row order is a keyboard/mouse affordance;
   the ▶ activate button stays, inline at the right edge). */
@media (max-width: 640px) {
  .lane-head { padding: 6px 30px 6px 8px; gap: 2px; }
  .lane-head__title { font-size: 0.8rem; gap: 5px; }
  .lane-head__dot { width: 6px; height: 6px; }
  .lane-head__sub, .gmini { font-size: 9px; }
  .gmini b { width: 22px; }
  .gmini:not(:first-child) { display: none; }
  .lane-head__drag-tt { display: none; }
  .lane-head__act-tt { right: 2px; }
  .lane-head__act { opacity: 1; width: 26px; height: 26px; }
  .lane-head--focus::before { top: 8px; bottom: 8px; width: 2px; }
}

@media (hover: none) and (pointer: coarse) {
  .lane { min-height: 76px; }
  /* Same touch spec as PlotNodeList: visible glyph stays small, hit area ≥ 44px. */
  .lane-head__drag { opacity: 0.4; min-width: 44px; min-height: 44px; display: grid; place-items: center; }
  .lane-head__drag-tt { right: 40px; }
  .lane-head__act { opacity: 1; min-width: 28px; min-height: 44px; }
  .lane-head__act-tt { right: 0; }
  .lane-anchor { opacity: 0.9; width: 44px; min-height: 44px; }
  .lane-anchor-tt { top: 16px; height: 44px; margin-left: -11px; }
}
/* Phone + touch: the head is too narrow for a 44px-tall ▶ (it read as a dark slab
   over the sub-line); 28×36 keeps a usable target without covering the text. */
@media (max-width: 640px) and (pointer: coarse) {
  .lane-head__act { min-width: 28px; width: 28px; min-height: 36px; height: 36px; }
}
</style>
