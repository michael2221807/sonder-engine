<script setup lang="ts">
/**
 * Weather badge — status-bar chip showing current weather name.
 *
 * No interaction / no popover. Weather is a plain string per schema; there's
 * no description or effect to reveal. If richer weather is added later, this
 * can gain an onClick handler without touching call sites.
 *
 * Polanyi: subsidiary awareness. The chip recedes to opacity 0.7 when the
 * user is focused on narrative; opens to 1.0 on hover so scanning the bar
 * pulls it forward.
 */
import { computed } from 'vue';
import { normalizeWeather } from './environment-helpers';

const props = defineProps<{
  weather: unknown;
}>();

const display = computed(() => normalizeWeather(props.weather));
</script>

<template>
  <span class="weather-badge">
    <span class="weather-badge__label">{{ $t('mainGame.env.weather.label') }}</span>
    <span class="weather-badge__value">{{ display }}</span>
  </span>
</template>

<style scoped>
.weather-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  opacity: 0.7;
  transition: opacity 0.18s ease;
  user-select: none;
  white-space: nowrap;
}

.weather-badge:hover {
  opacity: 1;
  text-shadow: 0 0 6px color-mix(in oklch, var(--color-amber-400) 20%, transparent);
}

.weather-badge__label {
  font-size: 0.7rem;
  color: var(--color-text-muted, var(--color-text-secondary));
  letter-spacing: 0.05em;
}

.weather-badge__value {
  font-weight: 600;
  color: var(--color-text);
}
</style>
