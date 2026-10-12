<script setup lang="ts">
// Design: docs/design/plot-parallel-threads-scheduler.md §5.4 (main-panel gauge strip — closes the
// `showGaugesInMainPanel` / `gauge.showInMainPanel` dead controls found 2026-08-22)
// App doc: docs/user-guide/pages/game-main.md §3.1 剧情度量抽屉
//
// 2026-10-10: the strip left the status bar's first row (on a phone it was squeezed to nothing under the right-hand
// controls) for a drawer below it, opened by PlotGaugeToggle. The panel owns which gauges show and the open state
// (useGaugeDrawer); this renders them, every name in full.
// 2026-10-12: one group per active thread (the focus thread first, marked), each under a line with its title.
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import type { MainPanelGaugeGroup } from '@/ui/composables/main-game/gauge-drawer';

defineProps<{
  groups: MainPanelGaugeGroup[];
  open: boolean;
}>();
</script>

<template>
  <div
    v-if="groups.length"
    class="gauge-drawer"
    :class="{ 'gauge-drawer--open': open }"
    data-testid="plot-gauge-strip"
    :aria-hidden="!open"
    :inert="!open"
  >
    <div class="gauge-drawer__clip">
      <div class="gauge-strip">
        <!-- One group per thread, named by its title for screen readers; `display: contents` keeps every cell in the
             drawer's one grid. -->
        <div
          v-for="group in groups"
          :key="group.arcId"
          class="gauge-strip__group"
          role="group"
          :aria-labelledby="`gauge-thread-${group.arcId}`"
        >
          <div class="gauge-strip__thread" :data-arc-id="group.arcId">
            <span class="gauge-strip__thread-dot" :style="{ background: group.color ?? 'var(--color-sage-400)' }" aria-hidden="true" />
            <span :id="`gauge-thread-${group.arcId}`" class="gauge-strip__thread-title">{{ group.title }}</span>
            <span v-if="group.focus" class="gauge-strip__thread-focus">{{ $t('mainGame.gauges.focus') }}</span>
          </div>
          <Tooltip
            v-for="g in group.gauges"
            :key="g.key"
            :text="g.gauge.description || g.thread"
            class="gauge-strip__item-tt"
            fixed
            position="bottom"
          >
            <span class="gauge-strip__item">
              <span class="gauge-strip__name">{{ g.gauge.name }}</span>
              <span class="gauge-strip__value">{{ g.text }}</span>
              <span class="gauge-strip__track"><span class="gauge-strip__fill" :style="{ width: g.pct + '%', background: g.gauge.color ?? 'var(--color-sage-400)' }" /></span>
            </span>
          </Tooltip>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Collapsed to no height, opened to its content's: the row track animates, so the story below moves down smoothly. */
.gauge-drawer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--duration-open) var(--ease-droplet);
}
.gauge-drawer--open { grid-template-rows: 1fr; }
.gauge-drawer__clip { overflow: hidden; min-height: 0; }
/* Several threads can bring many gauges: past this height the drawer scrolls inside (the global themed scrollbar)
   instead of pushing the story off the screen. */
.gauge-drawer--open .gauge-drawer__clip { max-height: min(45vh, 420px); overflow-y: auto; overscroll-behavior: contain; }

.gauge-strip {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px 24px;
  padding: 2px var(--sidebar-right-reserve, 40px) 12px var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet),
              padding-right var(--duration-open) var(--ease-droplet),
              opacity 0.3s var(--ease-out),
              transform var(--duration-open) var(--ease-droplet);
  opacity: 0;
  transform: translateY(-4px);
}
.gauge-drawer--open .gauge-strip {
  opacity: 1;
  transform: none;
  transition-delay: 0s, 0s, 0.08s, 0s;
}
.gauge-strip__thread {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}
.gauge-strip__group { display: contents; }
/* A second thread's group starts under a faint rule, with some air above it. */
.gauge-strip__group + .gauge-strip__group > .gauge-strip__thread {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border-subtle);
}
.gauge-strip__thread-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; opacity: 0.85; }
.gauge-strip__thread-title {
  font-family: var(--font-serif-cjk, serif);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gauge-strip__thread-focus {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: var(--radius-full);
  font-size: 10px;
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent);
}
.gauge-strip__item-tt { display: block; min-width: 0; }
.gauge-strip__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}
.gauge-strip__name {
  font-family: var(--font-serif-cjk, serif);
  font-size: 12px;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gauge-strip__value {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--color-text);
  white-space: nowrap;
}
.gauge-strip__track {
  grid-column: 1 / -1;
  display: block;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.07);
  overflow: hidden;
}
.gauge-strip__fill { display: block; height: 100%; border-radius: 2px; transition: width 0.6s var(--ease-out); }

@media (max-width: 767px) {
  .gauge-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    padding-left: var(--space-md);
    padding-right: var(--space-md);
  }
}

@media (prefers-reduced-motion: reduce) {
  .gauge-drawer, .gauge-strip, .gauge-strip__fill { transition: none; }
}
</style>
