<script setup lang="ts">
/**
 * Environment chip strip — status-bar display for `世界.环境` array.
 *
 * Shows comma-joined tag names (capped at 3 with "…+N" overflow suffix)
 * via `formatTagSummary`. Click anywhere on the chip opens the popover
 * which lists ALL tags with full 描述/效果.
 *
 * Component hides itself entirely when there are no valid tags — empty
 * state is communicated by absence rather than by a "无" placeholder,
 * matching the Polanyi "subsidiary recession" principle.
 */
import { ref, computed } from 'vue';
import { formatTagSummary, sanitizeTagList, countOverflow } from './environment-helpers';
import EnvironmentPopover from './EnvironmentPopover.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';

const props = defineProps<{
  tags: unknown;
}>();

const popoverOpen = ref(false);

const sanitized = computed(() => sanitizeTagList(props.tags));
const summary = computed(() => formatTagSummary(props.tags, 3));
const overflow = computed(() => countOverflow(props.tags, 3));

const hasAny = computed(() => sanitized.value.length > 0);

function open(): void {
  if (hasAny.value) popoverOpen.value = true;
}
</script>

<template>
  <template v-if="hasAny">
    <Tooltip
      :text="overflow > 0 ? $t('mainGame.env.environment.overflowTooltip', { n: sanitized.length }) : $t('mainGame.env.environment.defaultTooltip')"
      interactive
      fixed
      position="bottom"
    >
      <button
        type="button"
        class="env-chips"
        :aria-label="`${$t('mainGame.env.environment.label')}: ${summary}`"
        aria-haspopup="dialog"
        :aria-expanded="popoverOpen"
        @click="open"
      >
        <span class="env-chips__label">{{ $t('mainGame.env.environment.label') }}</span>
        <span class="env-chips__value">{{ summary }}</span>
      </button>
    </Tooltip>

    <EnvironmentPopover
      v-model="popoverOpen"
      :tags="sanitized"
    />
  </template>
</template>

<style scoped>
.env-chips {
  /* unstyle button base */
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
  max-width: 30ch;
  overflow: hidden;
  text-overflow: ellipsis;
}

.env-chips:hover {
  opacity: 1;
  transform: translateY(-1px);
  box-shadow: inset 0 0 6px color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

.env-chips:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  opacity: 1;
}

.env-chips__label {
  font-size: 0.7rem;
  color: var(--color-text-muted, var(--color-text-secondary));
  letter-spacing: 0.05em;
}

.env-chips__value {
  font-weight: 600;
  color: var(--color-text);
  /* Parent .env-chips already clips + ellipsizes; no need to repeat here */
}
</style>
