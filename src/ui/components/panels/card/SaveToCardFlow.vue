<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.7
/**
 * SaveToCardFlow — Story 7 (P6): thin composition wrapper for save-to-card.
 *
 * Honors the Story 5 reuse seam: mounts CardExportFlow in target mode and
 * injects EdgeClassifyPanel through the `pre-classify` slot; the confirmed
 * edge id Set flows back via `edgeIdsOverride`. SavePanel only provides the
 * target save coordinates — all data flow stays inside this wrapper.
 */
import { ref, watch } from 'vue';
import CardExportFlow from '@/ui/components/panels/card/CardExportFlow.vue';
import EdgeClassifyPanel from '@/ui/components/panels/engram/EdgeClassifyPanel.vue';

const props = defineProps<{
  modelValue: boolean;
  target: { profileId: string; slotId: string } | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const selectedIds = ref<Set<string> | null>(null);

// F4: the slot content unmounts with the Modal, but this ref lives here —
// reset on close so a reopened wizard never reuses a stale confirmed set.
watch(
  () => props.modelValue,
  (open) => {
    if (!open) selectedIds.value = null;
  },
);
</script>

<template>
  <!-- Gate on modelValue too so the slot subtree (EdgeClassifyPanel) actually unmounts
       on close → its onUnmounted abort fires and no stale classify run survives (R2 #8). -->
  <CardExportFlow
    v-if="props.modelValue && props.target"
    :model-value="props.modelValue"
    :target="props.target"
    :edge-ids-override="selectedIds"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #pre-classify="{ edges, entities, worldBrief, loading }">
      <EdgeClassifyPanel
        :edges="edges"
        :entities="entities"
        :world-brief="worldBrief"
        :loading="loading"
        @update:selected-ids="selectedIds = $event"
      />
    </template>
  </CardExportFlow>
</template>
