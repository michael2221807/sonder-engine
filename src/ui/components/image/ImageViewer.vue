<script setup lang="ts">
/**
 * ImageViewer — fullscreen image viewer modal.
 *
 * Usage: <ImageViewer v-if="viewerOpen" :src="imageUrl" @close="viewerOpen = false" />
 * Click overlay or press Escape to close.
 */
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { useBackdropClose } from '@/ui/composables/useBackdropClose';

const { t } = useI18n();

defineProps<{
  src: string;
  alt?: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));

const backdrop = useBackdropClose(() => emit('close'));
</script>

<template>
  <Teleport to="body">
    <div
      class="image-viewer-overlay"
      @pointerdown="backdrop.onPointerdown"
      @pointerup="backdrop.onPointerup"
    >
      <Tooltip :text="t('common.actions.close')" class="image-viewer-close-tt" position="bottom" interactive>
        <button class="image-viewer-close" @click="emit('close')" :aria-label="t('common.actions.close')">&times;</button>
      </Tooltip>
      <img :src="src" :alt="alt ?? ''" class="image-viewer-img" />
    </div>
  </Teleport>
</template>

<style scoped>
.image-viewer-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse 60% 50% at 50% 50%, rgba(0,0,0,0.85), rgba(0,0,0,0.95));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  cursor: zoom-out;
}

/* the absolute positioning lives on the Tooltip wrapper so the hint bubble anchors to the ×. */
.image-viewer-close-tt {
  position: absolute;
  top: var(--space-lg);
  right: var(--space-lg);
  z-index: 201;
}
.image-viewer-close {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: 2rem;
  cursor: pointer;
  z-index: 201;
  transition: color var(--duration-fast);
}
.image-viewer-close:hover { color: var(--color-text-bone); }

.image-viewer-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  cursor: default;
  box-shadow: 0 0 20px color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}
</style>
