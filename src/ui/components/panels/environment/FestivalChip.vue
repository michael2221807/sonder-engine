<script setup lang="ts">
/**
 * Festival chip — status-bar display for `世界.节日` single-object.
 *
 * Visible only when `isFestivalVisible` returns true (hidden for the default
 * `{名称:"平日", 描述:"", 效果:""}` state). Clicking opens FestivalPopover
 * with 描述 + 效果.
 */
import { ref, computed } from 'vue';
import { isFestivalVisible, normalizeFestival } from './environment-helpers';
import FestivalPopover from './FestivalPopover.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const props = defineProps<{
  festival: unknown;
}>();

const popoverOpen = ref(false);

/**
 * Single source of truth for visibility. `normalizeFestival` returns null
 * for the same cases `isFestivalVisible` returns false, EXCEPT it would
 * accept the default `平日` as valid data. We gate on `isFestivalVisible`
 * (which correctly hides the default `平日`) and use the normalized object
 * only when we've already decided to render.
 */
const visible = computed(() => isFestivalVisible(props.festival));
const normalized = computed(() => (visible.value ? normalizeFestival(props.festival) : null));

function open(): void {
  if (normalized.value) popoverOpen.value = true;
}
</script>

<template>
  <template v-if="normalized">
    <Tooltip :text="$t('mainGame.env.festival.titleTemplate', { name: normalized.名称 })" interactive fixed position="bottom">
      <button
        type="button"
        class="festival-chip"
        :aria-label="`${$t('mainGame.env.festival.label')} ${normalized.名称}`"
        aria-haspopup="dialog"
        :aria-expanded="popoverOpen"
        @click="open"
      >
        <span class="festival-chip__label">{{ $t('mainGame.env.festival.label') }}</span>
        <span class="festival-chip__value">{{ normalized.名称 }}</span>
      </button>
    </Tooltip>

    <FestivalPopover
      v-model="popoverOpen"
      :festival="normalized"
    />
  </template>
</template>

<style scoped>
.festival-chip {
  background: transparent;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;

  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  opacity: 0.7;
  transition: opacity 0.18s ease, transform 0.18s ease;
  user-select: none;
  white-space: nowrap;
}

.festival-chip:hover {
  opacity: 1;
  transform: translateY(-1px);
  box-shadow: inset 0 0 6px color-mix(in oklch, var(--color-amber-400) 8%, transparent);
}

.festival-chip:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-amber-400) 20%, transparent);
  opacity: 1;
}

.festival-chip__label {
  font-size: 0.7rem;
  color: var(--color-text-muted, var(--color-text-secondary));
  letter-spacing: 0.05em;
}

.festival-chip__value {
  font-weight: 600;
  color: var(--color-text);
}
</style>
