<script setup lang="ts">
// App doc: docs/user-guide/pages/game-main.md §3.1 第一行 · 右组（度量开关）
//
// The status bar's gauge drawer toggle (2026-10-10): a chip at the end of the first row — four little bars, a word
// and the count, a chevron. A breathing amber dot says a value changed while the drawer was closed. On a phone the
// word goes (`compact`: the bar is narrow, a phone or a tablet with both sidebars open), so the chips on the left
// keep room to scroll. Its hint is off while the drawer is open: the bubble
// would lie over the drawer it opened (CLAUDE.md §8.1).
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const props = defineProps<{
  count: number;
  open: boolean;
  changed: boolean;
  controls: string;
  compact?: boolean;
}>();
defineEmits<{ toggle: [] }>();

const { t } = useI18n();
const ariaLabel = computed(() => {
  const base = t('mainGame.gauges.toggleAria', { n: props.count });
  return props.changed ? `${base}${t('mainGame.gauges.changed')}` : base;
});
</script>

<template>
  <Tooltip :text="$t('mainGame.gauges.toggleHint')" interactive fixed position="bottom" :disabled="open">
    <button
      type="button"
      class="gauge-toggle"
      :class="{ 'gauge-toggle--open': open, 'gauge-toggle--changed': changed, 'gauge-toggle--compact': compact }"
      data-testid="gauge-drawer-toggle"
      :aria-expanded="open"
      :aria-controls="controls"
      :aria-label="ariaLabel"
      @click="$emit('toggle')"
    >
      <svg class="gauge-toggle__bars" viewBox="0 0 14 12" width="14" height="12" fill="currentColor" aria-hidden="true">
        <rect x="0" y="3" width="2.5" height="9" rx="0.8" />
        <rect x="3.8" y="7" width="2.5" height="5" rx="0.8" />
        <rect x="7.6" y="1" width="2.5" height="11" rx="0.8" />
        <rect x="11.4" y="5" width="2.5" height="7" rx="0.8" />
      </svg>
      <span class="gauge-toggle__word">{{ $t('mainGame.gauges.toggle') }}</span>
      <span class="gauge-toggle__count">{{ count }}</span>
      <svg class="gauge-toggle__chev" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" />
      </svg>
      <span v-if="changed" class="gauge-toggle__dot" aria-hidden="true" />
    </button>
  </Tooltip>
</template>

<style scoped>
.gauge-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px 0 10px;
  border: none;
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-text) 5%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.gauge-toggle:hover {
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-text) 9%, transparent);
}
.gauge-toggle--open {
  color: var(--color-sage-300);
  background: color-mix(in oklch, var(--color-sage-400) 14%, transparent);
}
.gauge-toggle:focus-visible { outline: 2px solid var(--color-sage-400); outline-offset: 2px; }
.gauge-toggle__bars { opacity: 0.8; flex-shrink: 0; }
.gauge-toggle__count { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.gauge-toggle__chev { flex-shrink: 0; transition: transform var(--duration-open) var(--ease-droplet); }
.gauge-toggle--open .gauge-toggle__chev { transform: rotate(180deg); }
.gauge-toggle__dot {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-amber-400);
  box-shadow: 0 0 6px var(--color-amber-400);
  animation: gauge-dot-breathe var(--duration-breath, 2.4s) ease-in-out infinite;
}
@keyframes gauge-dot-breathe {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.2); }
}

.gauge-toggle--compact { padding: 0 7px; gap: 4px; }
.gauge-toggle--compact .gauge-toggle__word { display: none; }

@media (prefers-reduced-motion: reduce) {
  .gauge-toggle__dot { animation: none; }
  .gauge-toggle__chev { transition: none; }
}
</style>
