<script setup lang="ts">
/**
 * Environment-tag popover — modal-backed detail view.
 *
 * Binds a list of tags (already sanitized) and renders each with the
 * Tag card layout:
 *
 *   [border-left gold accent]
 *   **名称** (bold, gold)
 *   描述    (muted, smaller)
 *   效果    (italic, green, smallest)  — only if non-empty
 *
 * When tag list is empty, shows the empty-state text
 * "风平浪静，并无特殊环境。" for consistency with the reference UX.
 *
 * ESC / backdrop click close (inherited from Modal.vue).
 * No keyboard navigation between entries per user Q&A.
 */
import Modal from '@/ui/components/common/Modal.vue';
import type { EnvironmentTag } from './environment-helpers';

defineProps<{
  modelValue: boolean;
  tags: EnvironmentTag[];
  title?: string;
}>();

defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="title ?? $t('mainGame.env.environment.popoverTitle')"
    width="360px"
    backdrop-close
    @update:model-value="(v) => $emit('update:modelValue', v)"
  >
    <div v-if="tags.length === 0" class="env-popover__empty">
      {{ $t('mainGame.env.environment.emptyState') }}
    </div>
    <div v-else class="env-popover__list">
      <div
        v-for="(tag, i) in tags"
        :key="`${i}-${tag.名称}`"
        class="env-popover__item"
      >
        <div class="env-popover__name">{{ tag.名称 }}</div>
        <div v-if="tag.描述" class="env-popover__desc">{{ tag.描述 }}</div>
        <div v-if="tag.效果" class="env-popover__effect">{{ tag.效果 }}</div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.env-popover__empty {
  padding: 0.5rem 0.25rem;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  text-align: center;
}

.env-popover__list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.env-popover__item {
  /* Theme-aware 20%-alpha primary color. `color-mix` is the cleanest way to
     derive an alpha variant from a CSS custom property without needing a
     separate `--color-primary-rgb` token. Supported in Chrome 111+ / FF 113+
     / Safari 16.2+; AGA targets modern Chromium only. */
  box-shadow: inset 3px 0 0 color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  padding-left: 0.5rem;
}

.env-popover__name {
  font-weight: 700;
  color: var(--color-amber-300);  /* "gold" name — distinct from the green effect line below */
  font-size: 0.95rem;
}

.env-popover__desc {
  font-size: 0.75rem;
  opacity: 0.8;
  margin-top: 0.25rem;
  line-height: 1.5;
}

.env-popover__effect {
  font-size: 0.68rem;
  color: var(--color-success);
  margin-top: 0.25rem;
  font-style: italic;
  line-height: 1.5;
}
</style>
