<script setup lang="ts">
// Design: docs/design/plot-parallel-threads-scheduler.md §5.4 (main-panel gauge strip — closes the
// `showGaugesInMainPanel` / `gauge.showInMainPanel` dead controls found 2026-08-22)
// App doc: docs/user-guide/pages/game-main.md §剧情度量条
import { computed } from 'vue';
import { useGameState } from '@/ui/composables/useGameState';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import { resolveFocusArc } from '@/engine/plot/types';
import type { PlotDirectionState, PlotGauge } from '@/engine/plot/types';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const { useValue } = useGameState();
const plotState = useValue<PlotDirectionState | undefined>(DEFAULT_ENGINE_PATHS.plotDirection);
const enabledSetting = useValue<boolean | undefined>('系统.设置.plot.showGaugesInMainPanel');
const plotEnabled = useValue<boolean | undefined>('系统.设置.plot.enabled');

/** Focus thread's gauges flagged for the main panel; empty when the setting is off. */
const gauges = computed<Array<{ gauge: PlotGauge; pct: number; text: string; thread: string }>>(() => {
  if (enabledSetting.value === false || plotEnabled.value === false) return [];
  const arc = resolveFocusArc(plotState.value);
  if (!arc) return [];
  return arc.gauges
    .filter(g => g.showInMainPanel)
    .map(gauge => {
      const range = gauge.max - gauge.min;
      const pct = range > 0 ? Math.round(((gauge.current - gauge.min) / range) * 100) : 0;
      return { gauge, pct, text: gauge.unit === '%' ? `${pct}%` : `${gauge.current}${gauge.unit}`, thread: arc.title };
    });
});
</script>

<template>
  <div v-if="gauges.length" class="gauge-strip" data-testid="plot-gauge-strip">
    <Tooltip v-for="g in gauges" :key="g.gauge.id" :text="g.gauge.description || g.thread" class="gauge-strip__item-tt">
      <span class="gauge-strip__item">
        <span class="gauge-strip__name">{{ g.gauge.name }}</span>
        <span class="gauge-strip__track"><span class="gauge-strip__fill" :style="{ width: g.pct + '%', background: g.gauge.color ?? 'var(--color-sage-400)' }" /></span>
        <span class="gauge-strip__value">{{ g.text }}</span>
      </span>
    </Tooltip>
  </div>
</template>

<style scoped>
.gauge-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  overflow: hidden;
  min-width: 0;
}
.gauge-strip__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-size: 10px;
  font-family: var(--font-mono, monospace);
  color: var(--color-text-muted, #888);
}
.gauge-strip__name { font-family: var(--font-serif-cjk, serif); font-size: 11px; color: var(--color-text-secondary, #aaa); }
.gauge-strip__track {
  display: inline-block;
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.gauge-strip__fill { display: block; height: 100%; transition: width 0.4s ease-out; }
@media (max-width: 640px) { .gauge-strip__name { display: none; } }
</style>
