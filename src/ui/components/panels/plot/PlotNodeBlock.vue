<script setup lang="ts">
// Design: docs/design/plot-parallel-threads-scheduler.md §5.2 (block visual semantics), §5.3 (block drag)
// App doc: docs/user-guide/pages/game-plot.md §时间线视图
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import type { LayoutNode } from './scheduler-layout';
import { DEFAULT_PROJECTED_ROUNDS } from './scheduler-layout';

const { t } = useI18n();

const props = defineProps<{
  layoutNode: LayoutNode;
  /** Pixel left / width from the axis. */
  left: number;
  width: number;
  /** Pixel x of each opportunity tier relative to the block, and whether it has been reached. */
  tiers: Array<{ left: number; hit: boolean }>;
  /** A critical-node confirmation gate is waiting on this node. */
  gated: boolean;
  /** Finished-thread rows render compact blocks. */
  compact?: boolean;
  /** The lane allows this block to be dragged sideways (pending node in a live lane). */
  draggable?: boolean;
  /** 'reorder' → moves among its siblings; 'schedule' → sets the thread's start round. */
  dragRole?: 'reorder' | 'schedule';
  /** This block is the one being dragged (follows the pointer by `dragDx`). */
  dragging?: boolean;
  dragDx?: number;
  /** Hide the hover hint (e.g. while any block in the lane is being dragged). */
  hintOff?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select'): void;
  (e: 'gate', anchor: HTMLElement): void;
  (e: 'drag-pointerdown', ev: PointerEvent): void;
  (e: 'drag-pointermove', ev: PointerEvent): void;
  (e: 'drag-pointerup', ev: PointerEvent): void;
  (e: 'drag-pointercancel', ev: PointerEvent): void;
  /** Keyboard nudge: -1 = earlier, +1 = later (reorder) / round ∓1 (schedule). */
  (e: 'move', dir: -1 | 1): void;
}>();

const node = computed(() => props.layoutNode.node);
const progressPct = computed(() => Math.min(100, Math.round(props.layoutNode.progress * 100)));
const overtime = computed(() => node.value.status === 'active' && props.layoutNode.progress > 1);

/** One sentence, clipped — a long narrative goal must not grow into a paragraph bubble. */
function clip(s: string, max = 100): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const tip = computed(() => {
  const n = node.value;
  const ln = props.layoutNode;
  if (n.narrativeGoal) return clip(n.narrativeGoal);
  if (n.status === 'active') {
    return t('plot.scheduler.blockActive', {
      start: ln.start,
      elapsed: Math.round(ln.progress * (n.maxRounds ?? DEFAULT_PROJECTED_ROUNDS)),
      max: n.maxRounds ?? DEFAULT_PROJECTED_ROUNDS,
    });
  }
  if (n.status === 'pending') return t('plot.scheduler.blockProjected', { start: ln.start, end: ln.end - 1 });
  return t('plot.scheduler.blockRounds', { start: ln.start, end: ln.end - 1 });
});

/** Accessible name carries the drag affordance (the visual cue is the grab cursor + texture). */
const aria = computed(() => {
  if (!props.draggable) return node.value.title;
  const hint = props.dragRole === 'schedule' ? t('plot.scheduler.dragScheduleAria') : t('plot.scheduler.dragNodeAria');
  return `${node.value.title} — ${hint}`;
});

// A pointer drag still ends in a native `click` on the captured element; a
// sideways move must not also open the node detail.
// State is keyed by pointerId: a second finger tapping the same block mid-drag
// must not corrupt the first pointer's gesture (review 2026-08-23).
let gesturePointer: number | null = null;
let downX = 0;
let lastX = 0;
function onDown(e: PointerEvent): void {
  if (gesturePointer !== null) return;
  gesturePointer = e.pointerId;
  downX = e.clientX;
  lastX = e.clientX;
  if (props.draggable) emit('drag-pointerdown', e);
}
function onMove(e: PointerEvent): void {
  if (e.pointerId !== gesturePointer) return;
  lastX = e.clientX;
  if (props.draggable) emit('drag-pointermove', e);
}
function onUp(e: PointerEvent): void {
  if (e.pointerId !== gesturePointer) return;
  if (props.draggable) emit('drag-pointerup', e);
}
function onCancel(e: PointerEvent): void {
  if (e.pointerId !== gesturePointer) return;
  gesturePointer = null;
  if (props.draggable) emit('drag-pointercancel', e);
}
function onClick(): void {
  const moved = gesturePointer !== null && Math.abs(lastX - downX) >= 5;
  gesturePointer = null;
  if (!moved) emit('select');
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); emit('select'); return; }
  if (!props.draggable) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); emit('move', -1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); emit('move', 1); }
}
</script>

<template>
  <Tooltip
    :text="tip"
    interactive
    fixed
    :disabled="hintOff"
    class="blk-tt"
    :class="{ 'blk-tt--dragging': dragging }"
    :style="{ left: left + 'px', width: width + 'px', transform: dragging ? `translateX(${dragDx ?? 0}px)` : undefined }"
  >
    <div
      :class="['blk', `blk--${node.status}`, {
        'blk--overtime': overtime,
        'blk--compact': compact,
        'blk--critical': node.importance === 'critical',
        'blk--draggable': draggable,
        'blk--dragging': dragging,
      }]"
      :style="node.status === 'active' ? { '--p': progressPct + '%' } : undefined"
      role="button"
      tabindex="0"
      :aria-label="aria"
      data-testid="plot-sched-block"
      :data-node-id="node.id"
      :data-drag-role="draggable ? dragRole : undefined"
      @click.stop="onClick"
      @keydown="onKey"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onCancel"
    >
      <!-- Clipped body: title + CRIT tag never spill past the block edge; the ✓ badge sits outside it on purpose. -->
      <span class="blk__body">
        <span class="blk__title">{{ node.title }}</span>
        <span v-if="node.importance === 'critical' && !compact" class="blk__crit">CRIT</span>
      </span>
      <span
        v-for="(tier, i) in tiers"
        :key="i"
        :class="['blk__tier', { 'blk__tier--hit': tier.hit }]"
        :style="{ left: tier.left + 'px' }"
      />
      <Tooltip v-if="gated" :text="$t('plot.scheduler.confirmBadge')" interactive fixed class="blk__badge-tt">
        <button
          class="blk__badge"
          type="button"
          data-testid="plot-sched-gate"
          :aria-label="$t('plot.scheduler.confirmBadge')"
          @click.stop="emit('gate', $event.currentTarget as HTMLElement)"
          @pointerdown.stop
        >✓</button>
      </Tooltip>
    </div>
  </Tooltip>
</template>

<style scoped>
.blk-tt {
  position: absolute;
  top: 18px;
  height: 40px;
  /* Blocks glide to their new column after a drop / reorder / reschedule
     instead of snapping (2026-08-23 feedback). Suspended while dragging. */
  transition: left 0.38s var(--ease-out, ease-out), transform 0.28s var(--ease-out, ease-out);
}
.blk-tt--dragging { z-index: 8; transition: none; }
@media (prefers-reduced-motion: reduce) { .blk-tt { transition: none; } }
.blk {
  position: relative;
  height: 40px;
  width: 100%;
  border-radius: 8px;
  padding: 0 11px;
  display: flex;
  align-items: center;
  font-size: var(--font-size-sm, 13px);
  font-family: var(--font-serif-cjk, serif);
  letter-spacing: 0.02em;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.2s var(--ease-out, ease-out), box-shadow 0.2s;
}
.blk:hover,
.blk:focus-visible {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  outline: none;
  z-index: 3;
}
.blk__body {
  display: flex;
  align-items: center;
  min-width: 0;
  overflow: hidden;
}
.blk__title {
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
/* Graspable (Polanyi): a subtle grip texture on the left edge + grab cursor — no label. */
.blk--draggable { cursor: grab; touch-action: pan-y; }
.blk--draggable::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 50%;
  width: 3px;
  height: 14px;
  transform: translateY(-50%);
  background: repeating-linear-gradient(to bottom, currentColor 0 2px, transparent 2px 4px);
  opacity: 0.28;
  border-radius: 1px;
}
.blk--dragging {
  cursor: grabbing;
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
}
.blk--compact {
  height: 22px;
  font-size: 10px;
  border-radius: 4px;
  padding: 0 8px;
}
.blk--completed {
  background: color-mix(in oklch, var(--color-sage-700, #5e7a5e) 55%, transparent);
  color: var(--color-sage-100, #e6efe6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.blk--active {
  background: linear-gradient(
    90deg,
    color-mix(in oklch, var(--color-amber-400, #d9a85c) 48%, transparent) var(--p),
    color-mix(in oklch, var(--color-amber-400, #d9a85c) 12%, transparent) var(--p)
  );
  color: var(--color-amber-100, #f5ecd9);
  box-shadow:
    inset 0 0 0 1px color-mix(in oklch, var(--color-amber-400, #d9a85c) 45%, transparent),
    0 0 16px color-mix(in oklch, var(--color-amber-400, #d9a85c) 12%, transparent);
}
.blk--overtime {
  animation: blk-breathe 2.4s ease-in-out infinite;
}
@keyframes blk-breathe {
  0%, 100% { box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-amber-400, #d9a85c) 45%, transparent), 0 0 10px color-mix(in oklch, var(--color-amber-400, #d9a85c) 10%, transparent); }
  50% { box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-amber-400, #d9a85c) 80%, transparent), 0 0 22px color-mix(in oklch, var(--color-amber-400, #d9a85c) 30%, transparent); }
}
.blk--pending {
  background: rgba(255, 255, 255, 0.015);
  border: 1px dashed rgba(255, 255, 255, 0.2);
  color: var(--color-text-muted, #999);
}
.blk--skipped {
  background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.05) 0 4px, transparent 4px 9px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--color-text-muted, #888);
  text-decoration: line-through;
}
.blk__crit {
  margin-left: 6px;
  font-size: 9px;
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.05em;
  color: var(--color-danger, #b85c4a);
  opacity: 0.8;
  flex: none;
}
.blk__tier {
  position: absolute;
  bottom: 0;
  width: 1px;
  height: 7px;
  background: color-mix(in oklch, var(--color-amber-300, #e2bd7a) 70%, transparent);
}
.blk__tier--hit {
  height: 10px;
  background: var(--color-amber-300, #e2bd7a);
}
.blk__badge-tt {
  position: absolute;
  right: -7px;
  top: -7px;
}
.blk__badge {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: var(--color-sage-400, #8cb88c);
  color: oklch(0.15 0.02 150);
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 0 0 3px var(--color-bg, #1a1917), 0 0 12px color-mix(in oklch, var(--color-sage-400, #8cb88c) 60%, transparent);
  animation: blk-pop 1.8s ease-in-out infinite;
}
@keyframes blk-pop {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.12); }
}
@media (prefers-reduced-motion: reduce) {
  .blk--overtime, .blk__badge { animation: none; }
}
@media (hover: none) and (pointer: coarse) {
  .blk { min-height: 44px; }
  .blk-tt { height: 44px; top: 16px; }
  .blk--draggable::before { opacity: 0.45; }
}
</style>
