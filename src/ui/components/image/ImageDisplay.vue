<script setup lang="ts">
/**
 * ImageDisplay
 *
 * Generic image display component with fallback to initial-letter avatar.
 * Resolves an asset ID from the image cache; shows fallback while loading
 * or when no asset exists.
 *
 * Used by: CharacterDetailsPanel (avatar), RelationshipPanel (NPC avatar), ImagePanel,
 * FormattedInline.
 */
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { ImageAssetCache } from '@/engine/image/asset-cache';

const sharedCache = new ImageAssetCache();

const props = defineProps<{
  assetId?: string | null;
  fallbackLetter?: string;
  alt?: string;
  /**
   * `sm|md|lg` are fixed square thumbnails (32/48/80px) used for avatars,
   * list items, and small chips. `fill` removes the hard cap — the component
   * expands to its container and the inner image uses `object-fit: contain`
   * with max-width/height 100%. Use `fill` inside preview panels, gallery
   * detail views, or any layout where the container defines the size.
   */
  size?: 'sm' | 'md' | 'lg' | 'fill';
}>();

const objectUrl = ref<string | null>(null);
const loading = ref(false);
const failed = ref(false);
const rootEl = ref<HTMLElement | null>(null);
const isVisible = ref(false);
let observer: IntersectionObserver | null = null;

async function loadAsset(assetId: string) {
  revokeUrl();
  failed.value = false;
  loading.value = true;
  try {
    const result = await sharedCache.retrieve(assetId);
    if (result) {
      objectUrl.value = URL.createObjectURL(result.blob);
    } else {
      failed.value = true;
    }
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (!rootEl.value) return;
  observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        isVisible.value = true;
        observer?.disconnect();
        observer = null;
        if (props.assetId) loadAsset(props.assetId);
      }
    },
    { rootMargin: '200px' },
  );
  observer.observe(rootEl.value);
});

watch(
  () => props.assetId,
  (newId) => {
    revokeUrl();
    failed.value = false;
    if (!newId) return;
    if (isVisible.value) loadAsset(newId);
  },
);

function revokeUrl() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value);
    objectUrl.value = null;
  }
}

onUnmounted(() => {
  observer?.disconnect();
  revokeUrl();
});

const sizeClass = `img-display--${props.size ?? 'md'}`;
</script>

<template>
  <div ref="rootEl" class="img-display" :class="sizeClass">
    <img
      v-if="objectUrl"
      :src="objectUrl"
      :alt="alt ?? ''"
      class="img-display__img"
    />
    <div v-else class="img-display__fallback">
      {{ fallbackLetter ?? '?' }}
    </div>
  </div>
</template>

<style scoped>
.img-display {
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-surface-elevated);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(0,0,0,0.15);
}
.img-display--sm { width: 32px; height: 32px; }
.img-display--md { width: 48px; height: 48px; }
.img-display--lg { width: 80px; height: 80px; }
/* `fill` lets the parent container define the size. Image uses contain-fit
   so aspect ratio is preserved without a hard cap. Used in preview panels. */
.img-display--fill {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
  flex-shrink: 1;
}

.img-display__img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.img-display--fill .img-display__img {
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.img-display__fallback {
  font-size: 1.2em;
  font-weight: 600;
  color: var(--color-text-secondary);
  text-transform: uppercase;
}
</style>
