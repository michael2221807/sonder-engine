<script setup lang="ts">
/**
 * AgaProgressBar — bounded metric display (currently the image-generation stats in ImagePanel).
 *
 * Shows a horizontal bar with optional label, value text, and color variant.
 */
import { computed } from 'vue';

const props = defineProps<{
  value: number;
  max: number;
  label?: string;
  showValue?: boolean;
  variant?: 'primary' | 'success' | 'danger' | 'warning';
}>();

const percentage = computed(() => {
  if (props.max <= 0) return 0;
  return Math.min(100, Math.max(0, (props.value / props.max) * 100));
});

// Expose both backgroundColor AND color on the fill element so the scoped
// CSS can use `currentColor` in `box-shadow` to generate an instrument-LED
// glow that matches whichever variant was chosen. No semantic change vs
// the previous barColor-only computed.
const barStyle = computed(() => {
  const v = props.variant ?? 'primary';
  const token = `var(--color-${v})`;
  return {
    width: percentage.value + '%',
    backgroundColor: token,
    color: token,
  };
});
</script>

<template>
  <div class="aga-progress" role="progressbar" :aria-valuenow="value" :aria-valuemin="0" :aria-valuemax="max">
    <div v-if="label || showValue" class="aga-progress__header">
      <span v-if="label" class="aga-progress__label">{{ label }}</span>
      <span v-if="showValue" class="aga-progress__value">{{ value }} / {{ max }}</span>
    </div>
    <div class="aga-progress__track">
      <div
        class="aga-progress__fill"
        :style="barStyle"
      />
    </div>
  </div>
</template>

<style scoped>
.aga-progress { width: 100%; }
.aga-progress__header {
  display: flex;
  justify-content: space-between;
  margin-bottom: var(--space-2xs);
}
.aga-progress__label { font-size: var(--font-size-xs); color: var(--color-text-secondary); }
.aga-progress__value { font-size: var(--font-size-xs); color: var(--color-text-muted); font-family: var(--font-mono); }
.aga-progress__track {
  height: 6px;
  background: var(--color-surface-elevated);
  border-radius: var(--radius-full);
  overflow: hidden;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  border: 1px solid color-mix(in oklch, var(--color-border) 40%, transparent);
}
.aga-progress__fill {
  position: relative;
  height: 100%;
  border-radius: var(--radius-full);
  box-shadow:
    0 0 8px color-mix(in oklch, currentColor 40%, transparent),
    inset 0 1px 1px rgba(255, 255, 255, 0.15);
  transition: width var(--duration-slow) var(--ease-out);
}
</style>
