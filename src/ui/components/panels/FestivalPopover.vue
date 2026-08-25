<script setup lang="ts">
/**
 * Festival popover — single-entry variant of EnvironmentPopover.
 *
 * Same visual grammar (gold left border, bold name, muted description,
 * italic-green effect) but only one tag to render. Title defaults to
 * "节日详情" to distinguish from the multi-entry env popover.
 */
import Modal from '@/ui/components/common/Modal.vue';
import type { EnvironmentTag } from './environment-helpers';

defineProps<{
  modelValue: boolean;
  festival: EnvironmentTag;
}>();

defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="$t('mainGame.env.festival.popoverTitle')"
    width="360px"
    backdrop-close
    @update:model-value="(v) => $emit('update:modelValue', v)"
  >
    <div class="festival-popover__item">
      <div class="festival-popover__name">{{ festival.名称 }}</div>
      <div v-if="festival.描述" class="festival-popover__desc">{{ festival.描述 }}</div>
      <div v-if="festival.效果" class="festival-popover__effect">{{ festival.效果 }}</div>
      <div
        v-if="!festival.描述 && !festival.效果"
        class="festival-popover__empty"
      >
        {{ $t('mainGame.env.festival.noDescription') }}
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.festival-popover__item {
  /* Theme-aware 20%-alpha primary. See EnvironmentPopover.vue for rationale. */
  box-shadow: inset 3px 0 0 color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  padding-left: 0.5rem;
}

.festival-popover__name {
  font-weight: 700;
  color: var(--color-primary);
  font-size: 0.95rem;
}

.festival-popover__desc {
  font-size: 0.75rem;
  opacity: 0.8;
  margin-top: 0.25rem;
  line-height: 1.5;
}

.festival-popover__effect {
  font-size: 0.68rem;
  color: var(--color-success);
  margin-top: 0.25rem;
  font-style: italic;
  line-height: 1.5;
}

.festival-popover__empty {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 0.25rem;
  opacity: 0.6;
}
</style>
