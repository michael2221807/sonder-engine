<script setup lang="ts">
// App doc: docs/user-guide/pages/game-plot.md §节点链 (Node Chain)
import { computed, ref, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import type { PlotNode, PlotGauge, GaugeCondition, PlotEvalLog } from '@/engine/plot/types';

const { t } = useI18n();

const props = defineProps<{
  nodes: PlotNode[];
  gauges: PlotGauge[];
  currentRound: number;
  lastEvalLog?: PlotEvalLog | null;
  /** Show ✓/⏭ on the active row (requires the evaluation pipeline — parent passes false when it is unavailable so the controls are never dead). */
  forceEnabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'reorder', nodeId: string, toIndex: number): void;
  /** gapIndex = insert before nodes[gapIndex]; null = append (resolved at submit time). */
  (e: 'insert-at', gapIndex: number | null): void;
  (e: 'remove', nodeId: string): void;
  (e: 'select', nodeId: string): void;
  /** Manual node resolution (design plot-arc-revise-extend §4.2) — parent opens the confirm layer. */
  (e: 'force-complete', nodeId: string): void;
  (e: 'force-skip', nodeId: string): void;
}>();

function statusIcon(status: PlotNode['status']): string {
  switch (status) {
    case 'completed': return '✅';
    case 'active':    return '🔵';
    case 'skipped':   return '⏭️';
    default:          return '○';
  }
}

function roundInfo(node: PlotNode): string {
  if (node.status !== 'active' || !node.activatedAtRound) return '';
  const elapsed = props.currentRound - node.activatedAtRound;
  const max = node.maxRounds ? `/${node.maxRounds}` : '';
  return `[${elapsed}${max}${t('plot.node.roundUnit')}]`;
}

function conditionLabel(cond: GaugeCondition): string {
  const gauge = props.gauges.find(g => g.id === cond.gaugeId);
  const name = gauge?.name ?? cond.gaugeId;
  const opMap: Record<string, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠' };
  return `${name}${opMap[cond.operator] ?? '?'}${cond.value}`;
}

const activeNodeCurrentTier = computed(() => {
  const active = props.nodes.find(n => n.status === 'active');
  if (!active || !active.activatedAtRound || active.opportunityTiers.length === 0) return null;
  const elapsed = props.currentRound - active.activatedAtRound;
  let current: number | null = null;
  for (const t of active.opportunityTiers) {
    if (elapsed >= t.afterRounds) current = t.tier;
  }
  return current;
});

// ─── Reorder / insert geometry ───
// A pending node placed at or before the last non-pending node (the
// active/completed/skipped prefix) would never activate — the evaluation
// pipeline only scans forward. All drop targets and insert gaps live
// strictly after this floor. Mirrors plot-store._reachableFloor.

const floorIndex = computed(() =>
  props.nodes.reduce((max, n, i) => (n.status !== 'pending' ? i : max), -1),
);

/** Gap g = "insert before nodes[g]". The bottom add button covers gap n. */
function isValidGap(g: number): boolean {
  return g > floorIndex.value;
}

function isDraggable(node: PlotNode): boolean {
  // Need at least two reachable slots for a move to mean anything.
  return node.status === 'pending' && props.nodes.length - (floorIndex.value + 1) >= 2;
}

// ─── Pointer drag state ───

const listEl = ref<HTMLElement | null>(null);
const dragNodeId = ref<string | null>(null);
const dragFromIndex = ref(-1);
const dragActivated = ref(false);
const dragDeltaY = ref(0);
/** Final resting index (plot-store.moveNode semantics), null = no valid drop. */
const dropFinalIndex = ref<number | null>(null);

let activePointerId: number | null = null;
let startPointerY = 0;
let lastPointerY = 0;
let startScrollTop = 0;
let scrollParent: HTMLElement | null = null;
let scrollRAF = 0;

/** Pointer delta + auto-scroll delta — keeps the lifted row under the finger while the list scrolls. */
function refreshDragDelta(): void {
  const scrollDelta = scrollParent ? scrollParent.scrollTop - startScrollTop : 0;
  dragDeltaY.value = (lastPointerY - startPointerY) + scrollDelta;
}

/** DOM gap position of the drop indicator, in original-array terms. */
const indicatorGap = computed<number | null>(() => {
  const k = dropFinalIndex.value;
  if (k === null || !dragActivated.value) return null;
  return k < dragFromIndex.value ? k : k + 1;
});

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur = el?.parentElement ?? null;
  while (cur) {
    if (/(auto|scroll)/.test(getComputedStyle(cur).overflowY)) return cur;
    cur = cur.parentElement;
  }
  return null;
}

function updateDropTarget(clientY: number): void {
  const list = listEl.value;
  if (!list || dragFromIndex.value < 0) return;
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-plot-row]'));

  // Work in "array without the dragged node" space: the number of remaining
  // rows whose midpoint sits above the pointer IS the final resting index.
  let k = 0;
  let floorAfter = -1;
  let j = 0;
  rows.forEach((el, i) => {
    if (i === dragFromIndex.value) return;
    const r = el.getBoundingClientRect();
    if (clientY > r.top + r.height / 2) k++;
    if (props.nodes[i] && props.nodes[i].status !== 'pending') floorAfter = j;
    j++;
  });

  // Same-position drops and drops inside the non-pending prefix are refused.
  dropFinalIndex.value = (k === dragFromIndex.value || k <= floorAfter) ? null : k;
}

function startAutoScroll(): void {
  cancelAnimationFrame(scrollRAF);
  const step = (): void => {
    if (!dragActivated.value) return;
    if (scrollParent) {
      const r = scrollParent.getBoundingClientRect();
      const zone = 48;
      let dy = 0;
      if (lastPointerY < r.top + zone) dy = -Math.ceil((r.top + zone - lastPointerY) / 6);
      else if (lastPointerY > r.bottom - zone) dy = Math.ceil((lastPointerY - (r.bottom - zone)) / 6);
      if (dy !== 0) {
        scrollParent.scrollTop += dy;
        refreshDragDelta();
        updateDropTarget(lastPointerY);
      }
    }
    scrollRAF = requestAnimationFrame(step);
  };
  scrollRAF = requestAnimationFrame(step);
}

function onDragEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') resetDrag();
}

function onHandlePointerDown(e: PointerEvent, node: PlotNode, idx: number): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  // Single-drag slot: a second pointer (e.g. another finger) must not hijack
  // the in-flight drag's shared state.
  if (dragNodeId.value !== null) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  activePointerId = e.pointerId;
  dragNodeId.value = node.id;
  dragFromIndex.value = idx;
  dragActivated.value = false;
  dragDeltaY.value = 0;
  dropFinalIndex.value = null;
  startPointerY = e.clientY;
  lastPointerY = e.clientY;
  scrollParent = findScrollParent(listEl.value);
  startScrollTop = scrollParent?.scrollTop ?? 0;
  window.addEventListener('keydown', onDragEscape);
}

function onHandlePointerMove(e: PointerEvent): void {
  if (dragNodeId.value === null || e.pointerId !== activePointerId) return;
  lastPointerY = e.clientY;
  if (!dragActivated.value) {
    if (Math.abs(e.clientY - startPointerY) < 5) return;
    dragActivated.value = true;
    startAutoScroll();
  }
  refreshDragDelta();
  updateDropTarget(e.clientY);
}

function onHandlePointerUp(e: PointerEvent): void {
  if (dragNodeId.value === null || e.pointerId !== activePointerId) return;
  if (dragActivated.value && dropFinalIndex.value !== null) {
    emit('reorder', dragNodeId.value, dropFinalIndex.value);
  }
  resetDrag();
}

function onHandlePointerCancel(e: PointerEvent): void {
  if (e.pointerId !== activePointerId) return;
  resetDrag();
}

function resetDrag(): void {
  dragNodeId.value = null;
  dragFromIndex.value = -1;
  dragActivated.value = false;
  dragDeltaY.value = 0;
  dropFinalIndex.value = null;
  activePointerId = null;
  scrollParent = null;
  cancelAnimationFrame(scrollRAF);
  window.removeEventListener('keydown', onDragEscape);
}

onBeforeUnmount(resetDrag);

// ─── Keyboard reorder (a11y fallback for the drag handle) ───

function onHandleKeydown(e: KeyboardEvent, node: PlotNode, idx: number): void {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const target = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
  if (target <= floorIndex.value || target > props.nodes.length - 1) return;
  emit('reorder', node.id, target);
}
</script>

<template>
  <div ref="listEl" :class="['node-list', { 'node-list--dragging': dragActivated }]">
    <div
      v-for="(node, idx) in nodes"
      :key="node.id"
      class="node-row-wrap"
    >
      <!-- Insert-between hot strip (gap before this node) -->
      <button
        v-if="isValidGap(idx) && !dragActivated"
        class="gap-strip"
        type="button"
        data-testid="plot-gap-insert"
        :aria-label="$t('plot.node.insertHere')"
        @click.stop="emit('insert-at', idx)"
      >
        <span class="gap-strip__line" />
        <span class="gap-strip__plus">+</span>
        <span class="gap-strip__line" />
      </button>

      <!-- Drop indicator during drag -->
      <div v-if="indicatorGap === idx" class="drop-indicator" />
      <div
        v-if="idx === nodes.length - 1 && indicatorGap === nodes.length"
        class="drop-indicator drop-indicator--end"
      />

      <div
        :class="['node-item', `node-item--${node.status}`, { 'node-item--dragging': dragActivated && node.id === dragNodeId }]"
        :style="dragActivated && node.id === dragNodeId ? { transform: `translateY(${dragDeltaY}px)` } : undefined"
        data-plot-row
        data-testid="plot-node-item"
        @click="emit('select', node.id)"
      >
        <Tooltip v-if="isDraggable(node)" class="node-drag-tt" :text="$t('plot.node.dragToReorder')" interactive>
          <button
            class="node-drag-handle"
            type="button"
            data-testid="plot-drag-handle"
            :aria-label="$t('plot.node.dragHandleAria')"
            @click.stop
            @pointerdown="onHandlePointerDown($event, node, idx)"
            @pointermove="onHandlePointerMove"
            @pointerup="onHandlePointerUp"
            @pointercancel="onHandlePointerCancel"
            @keydown="onHandleKeydown($event, node, idx)"
          >⋮⋮</button>
        </Tooltip>
        <span v-else class="node-drag-spacer" aria-hidden="true" />

        <div class="node-item__indicator">
          <span class="node-item__icon">{{ statusIcon(node.status) }}</span>
          <div v-if="idx < nodes.length - 1" class="node-item__line" />
        </div>

        <div class="node-item__body">
          <div class="node-item__header">
            <span class="node-item__title">{{ node.title }}</span>
            <span v-if="node.status === 'active'" class="node-item__round">
              {{ roundInfo(node) }}
            </span>
            <span v-if="node.importance === 'critical'" class="node-item__badge node-item__badge--critical">
              {{ $t('plot.node.importance.critical') }}
            </span>
          </div>

          <p v-if="node.status === 'active'" class="node-item__goal">
            {{ node.narrativeGoal }}
          </p>

          <div v-if="node.status === 'active' && activeNodeCurrentTier" class="node-item__tier">
            {{ $t('plot.node.tierGuiding', { tier: activeNodeCurrentTier }) }}
          </div>

          <!-- Evaluation status for active node -->
          <div v-if="node.status === 'active' && lastEvalLog?.evaluation" class="node-item__eval">
            <span :class="['eval-dot', lastEvalLog.evaluation.node_reached ? 'eval-dot--reached' : 'eval-dot--miss']" />
            <span class="eval-conf">{{ (lastEvalLog.evaluation.confidence * 100).toFixed(0) }}%</span>
            <span v-if="node.consecutiveReachedCount > 0" class="eval-streak">
              {{ node.consecutiveReachedCount }}/{{ node.importance === 'critical' ? 2 : 1 }}
            </span>
          </div>
          <p v-if="node.status === 'active' && lastEvalLog?.evaluation?.evidence" class="node-item__evidence">
            {{ lastEvalLog.evaluation.evidence }}
          </p>

          <div v-if="node.activationConditions.length > 0 && node.status === 'pending'" class="node-item__conditions">
            {{ $t('plot.node.requires') }}
            <span v-for="(cond, ci) in node.activationConditions" :key="ci" class="node-item__cond-tag">
              {{ conditionLabel(cond) }}
            </span>
          </div>

          <div v-if="node.completionConditions.length > 0 && node.status === 'active'" class="node-item__conditions">
            {{ $t('plot.node.completionConditions') }}
            <span v-for="(cond, ci) in node.completionConditions" :key="ci" class="node-item__cond-tag">
              {{ conditionLabel(cond) }}
            </span>
          </div>

          <div v-if="node.status === 'completed'" class="node-item__completed-round">
            R{{ node.activatedAtRound }}-R{{ node.completedAtRound }}
          </div>
        </div>

        <div class="node-item__actions">
          <template v-if="node.status === 'active' && forceEnabled">
            <Tooltip :text="$t('plot.node.forceComplete')" interactive>
              <button
                class="node-action-btn node-action-btn--force-complete"
                data-testid="plot-force-complete"
                :aria-label="$t('plot.node.forceComplete')"
                @click.stop="emit('force-complete', node.id)"
              >✓</button>
            </Tooltip>
            <Tooltip :text="$t('plot.node.forceSkip')" interactive>
              <button
                class="node-action-btn node-action-btn--force-skip"
                data-testid="plot-force-skip"
                :aria-label="$t('plot.node.forceSkip')"
                @click.stop="emit('force-skip', node.id)"
              >⏭</button>
            </Tooltip>
          </template>
          <Tooltip v-if="node.status === 'pending'" :text="$t('plot.node.removeNode')" interactive>
            <button
              class="node-action-btn node-action-btn--remove"
              @click.stop="emit('remove', node.id)"
            >&times;</button>
          </Tooltip>
        </div>
      </div>
    </div>

    <Tooltip :text="$t('plot.node.addAtEnd')" interactive>
      <button
        class="insert-btn"
        @click="emit('insert-at', null)"
      >+ {{ $t('plot.node.addTitle') }}</button>
    </Tooltip>
  </div>
</template>

<style scoped>
.node-list {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.node-list--dragging {
  user-select: none;
  -webkit-user-select: none;
}
/* The pointer parks on the handle while dragging — keep the hover hint from
   popping mid-drag. */
.node-list--dragging :deep(.tt-bubble) {
  display: none;
}

.node-row-wrap {
  position: relative;
}

.node-item {
  display: flex;
  gap: 10px;
  padding: 8px 4px;
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s;
}
.node-item:hover {
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}
.node-item--dragging {
  position: relative;
  z-index: 5;
  opacity: 0.92;
  background: color-mix(in oklch, var(--color-sage-400) 8%, rgba(30, 30, 34, 0.9));
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35),
    inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
  transition: none;
}
.node-list--dragging .node-item {
  cursor: grabbing;
}

/* ── Drag handle ── */
.node-drag-tt {
  align-self: stretch;
}
.node-drag-handle {
  height: 100%;
  background: none;
  border: none;
  width: 16px;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 4px;
  color: var(--color-text-secondary);
  font-size: 11px;
  letter-spacing: -2px;
  line-height: 1;
  cursor: grab;
  opacity: 0;
  touch-action: none;
  transition: opacity 0.15s, color 0.15s;
}
.node-item:hover .node-drag-handle,
.node-drag-handle:focus-visible {
  opacity: 0.75;
}
.node-drag-handle:hover {
  color: var(--color-text, #e0e0e6);
  opacity: 1;
}
.node-drag-handle:active {
  cursor: grabbing;
}
.node-item--dragging .node-drag-handle {
  opacity: 1;
  color: var(--color-sage-400, #8cb88c);
}
.node-drag-spacer {
  width: 16px;
  flex-shrink: 0;
}

/* ── Insert-between hot strip ── */
.gap-strip {
  position: absolute;
  top: -8px;
  left: 26px;
  right: 4px;
  height: 16px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.gap-strip:hover,
.gap-strip:focus-visible {
  opacity: 1;
}
.gap-strip__line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
}
.gap-strip__plus {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  line-height: 1;
  color: var(--color-sage-400, #8cb88c);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--color-sage-400) 55%, transparent);
  background: rgba(30, 30, 34, 0.85);
}

/* ── Drop indicator ── */
.drop-indicator {
  position: absolute;
  top: -1px;
  left: 22px;
  right: 4px;
  height: 2px;
  border-radius: 1px;
  background: var(--color-sage-400, #8cb88c);
  box-shadow: 0 0 6px color-mix(in oklch, var(--color-sage-400) 60%, transparent);
  z-index: 4;
  pointer-events: none;
}
.drop-indicator--end {
  top: auto;
  bottom: -1px;
}

.node-item__indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 24px;
  flex-shrink: 0;
}
.node-item__icon {
  font-size: 14px;
  line-height: 1;
}
.node-item__line {
  flex: 1;
  width: 1px;
  margin-top: 4px;
  background: var(--color-border-subtle, rgba(255,255,255,0.08));
}

.node-item__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.node-item__header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.node-item__title {
  font-size: var(--font-size-md, 14px);
  font-weight: 600;
  color: var(--color-text, #e0e0e6);
  font-family: var(--font-serif-cjk, serif);
}
.node-item--pending .node-item__title {
  color: var(--color-text-secondary, #aaa);
}
.node-item--skipped .node-item__title {
  color: var(--color-text-secondary, #aaa);
  text-decoration: line-through;
}

.node-item__round {
  font-size: 11px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono, monospace);
}

.node-item__badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 600;
}
.node-item__badge--critical {
  background: color-mix(in oklch, var(--color-amber-400) 15%, transparent);
  color: var(--color-amber-400);
}

.node-item__goal {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin: 0;
  line-height: 1.5;
}

.node-item__tier {
  font-size: 11px;
  color: var(--color-sage-400, #8cb88c);
  font-family: var(--font-mono, monospace);
}

.node-item__conditions {
  font-size: 11px;
  color: var(--color-text-secondary);
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.node-item__cond-tag {
  background: color-mix(in oklch, var(--color-text-umber) 12%, transparent);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}

.node-item__eval {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
}
.eval-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.eval-dot--reached { background: var(--color-sage-400, #8cb88c); }
.eval-dot--miss    { background: var(--color-text-secondary, #888); opacity: 0.5; }
.eval-conf {
  color: var(--color-amber-400, #f59e0b);
}
.eval-streak {
  color: var(--color-sage-400, #8cb88c);
  font-weight: 600;
}

.node-item__evidence {
  font-size: 11px;
  color: var(--color-text-secondary);
  margin: 0;
  line-height: 1.4;
  font-style: italic;
  opacity: 0.8;
}

.node-item__completed-round {
  font-size: 11px;
  color: var(--color-text-secondary);
  font-family: var(--font-mono, monospace);
}

.node-item__actions {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  /* The gap-strip insert overlay covers the row's top 8px (top:-8px + height
     16px, z-index 2, spanning to right:4px). Start the action buttons below
     that band, or a click aimed at them hits the invisible strip instead. */
  padding-top: 8px;
}

.node-action-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--color-text-secondary);
  padding: 2px 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.node-item:hover .node-action-btn {
  opacity: 1;
}
.node-action-btn--remove:hover {
  color: var(--color-danger, #c0392b);
}
.node-action-btn--force-complete:hover {
  color: var(--color-sage-400, #8cb88c);
}
.node-action-btn--force-skip:hover {
  color: var(--color-amber-400, #d9a85c);
}

.insert-btn {
  margin-top: 4px;
  padding: 6px 12px;
  background: none;
  border: 1px dashed var(--color-border-subtle, rgba(255,255,255,0.1));
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.insert-btn:hover {
  border-color: var(--color-sage-400, #8cb88c);
  color: var(--color-sage-400, #8cb88c);
}

@media (max-width: 767px) {
  .node-drag-handle {
    width: 44px;
    min-width: 44px;
    min-height: 44px;
    opacity: 0.5;
  }
  .node-drag-spacer { width: 44px; }
}

/* Touch-primary devices: hover-revealed affordances must be visible, and the
   overlay gap strip becomes an in-flow 44px row (doctrine minimum tap target —
   a 44px overlay would swallow taps meant for the node rows). */
@media (hover: none) and (pointer: coarse) {
  .node-drag-handle { opacity: 0.5; }
  .node-action-btn { opacity: 0.5; min-width: 44px; }
  .gap-strip {
    position: static;
    height: 44px;
    opacity: 0.35;
  }
}

@media (prefers-reduced-motion: reduce) {
  .node-item,
  .node-drag-handle,
  .gap-strip { transition: none; }
}
</style>
