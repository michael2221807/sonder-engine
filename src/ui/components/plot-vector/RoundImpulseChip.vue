<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.18.9 · Plot-vector card table
/**
 * The round's push in two words beside the round counter (PO 3A, charter I27): worked out by the engine from
 * the packet the model read, never written by the model. Shown only for the round the board shaped. It lands
 * like a stamp when a new round's push appears (phase 7 polish).
 */
import { computed, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '../shared/Tooltip.vue';
import { useGameState } from '@/ui/composables/useGameState';
import { DEFAULT_ENGINE_PATHS as P } from '@/engine/pipeline/types';
import { readPlotVectorControl, subscribePlotVectorControl } from '@/engine/plot-vector/feature-control';
import { readVectorState } from '@/features/plot-vector/runtime';
import { roundImpulse } from '@/features/plot-vector/round-impulse';

const { t } = useI18n();
const { useValue } = useGameState();
const stored = useValue<unknown>(P.plotVector);
const round = useValue<number>(P.roundNumber);
const enabled = ref(readPlotVectorControl().enabled);
onUnmounted(subscribePlotVectorControl(() => { enabled.value = readPlotVectorControl().enabled; }));

const impulse = computed(() => (enabled.value && stored.value && typeof round.value === 'number'
  ? roundImpulse(readVectorState(stored.value), round.value) : null));
const text = computed(() => {
  const i = impulse.value;
  if (!i) return '';
  const tone = t(`mainGame.vectorTable.impulse.tone.${i.tone}`);
  return i.lean ? `${tone} · ${t(`mainGame.vectorTable.impulse.lean.${i.lean}`)}` : tone;
});
</script>

<template>
  <Transition name="vimpulse">
    <Tooltip v-if="impulse" :key="text" :text="t('mainGame.vectorTable.impulse.hint')">
      <span class="vimpulse" :class="`vimpulse--${impulse.tone}`" data-testid="vector-impulse" :aria-label="`${t('mainGame.vectorTable.impulse.label')}：${text}`">{{ text }}</span>
    </Tooltip>
  </Transition>
</template>

<style scoped>
.vimpulse {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.vimpulse::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
.vimpulse--against, .vimpulse--hard { color: var(--color-amber-300); background: color-mix(in oklch, var(--color-amber-400) 10%, transparent); }
.vimpulse--even { color: var(--color-text-secondary); background: color-mix(in oklch, var(--color-text-secondary) 8%, transparent); }
.vimpulse-enter-active { animation: vimpulse-stamp 520ms var(--ease-out); }
@keyframes vimpulse-stamp {
  0% { opacity: 0; transform: scale(1.18); clip-path: circle(0% at 50% 50%); }
  45% { opacity: 1; transform: scale(0.98); clip-path: circle(90% at 50% 50%); }
  100% { opacity: 1; transform: scale(1); clip-path: circle(120% at 50% 50%); }
}
.vimpulse-leave-active { transition: opacity var(--duration-fast) var(--ease-out); }
.vimpulse-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .vimpulse-enter-active { animation: none; }
  .vimpulse-leave-active { transition: none; }
}
</style>
