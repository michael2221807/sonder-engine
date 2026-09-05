<script setup lang="ts">
// App doc: docs/user-guide/pages/game-save.md §2.5.1
/**
 * CardExportChecklist — the selective-export checklist for Game Card export (Story 5, P5 / U4).
 * Reusable by Story 7. Each optional item carries a one-sentence Tooltip hint (U12 consumption point).
 */
import { useI18n } from 'vue-i18n';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import type { ExportFlags } from '@/engine/export/game-card-bundle.types';

const props = defineProps<{ modelValue: ExportFlags }>();
const emit = defineEmits<{ (e: 'update:modelValue', v: ExportFlags): void }>();

const { t } = useI18n();

/** Optional creative-asset toggles → (ExportFlags field, i18n key stem). */
const CREATIVE: { field: keyof ExportFlags; key: string }[] = [
  { field: 'includedWorldBooks', key: 'worldBook' },
  { field: 'includedBuiltinOverrides', key: 'builtinOverride' },
  { field: 'includedEngineConfig', key: 'engineConfig' },
  { field: 'includedPromptSettings', key: 'promptSettings' },
  { field: 'includedHeroinePlan', key: 'heroinePlan' },
  { field: 'includedPlotDirection', key: 'plotDirection' },
  { field: 'includedNarrativeContract', key: 'narrativeContract' },
  { field: 'includedSettings', key: 'settings' },
  { field: 'includedApiTemplate', key: 'apiTemplate' },
];

function toggle(field: keyof ExportFlags): void {
  emit('update:modelValue', { ...props.modelValue, [field]: !props.modelValue[field] });
}
</script>

<template>
  <div class="ckl">
    <!-- Core (always included) -->
    <div class="ckl-core">
      <p class="ckl-core__title">{{ t('save.export.content.coreTitle') }}</p>
      <p class="ckl-core__body">{{ t('save.export.content.core') }}</p>
    </div>

    <!-- Optional creative assets -->
    <p class="ckl-group-title">{{ t('save.export.content.optionalTitle') }}</p>
    <div class="ckl-list">
      <label v-for="item in CREATIVE" :key="item.field" class="ckl-row">
        <input
          type="checkbox"
          class="ckl-box"
          :checked="modelValue[item.field]"
          @change="toggle(item.field)"
        />
        <span class="ckl-label">{{ t(`save.export.checklist.${item.key}.label`) }}</span>
        <!-- `?` sits at the row's right edge (flex:1 label) — open the bubble leftward so a
             wide hint never overflows the modal's right boundary (no horizontal scrollbar). -->
        <Tooltip :text="t(`save.export.checklist.${item.key}.hint`)" position="left">
          <span class="ckl-info" aria-hidden="true">?</span>
        </Tooltip>
      </label>
    </div>

    <!-- Images -->
    <p class="ckl-group-title">{{ t('save.export.images.sectionTitle') }}</p>
    <div class="ckl-list">
      <p class="ckl-static">{{ t('save.export.images.selectedOnly') }}</p>
      <div class="ckl-toggle">
        <AgaToggle
          :model-value="modelValue.includedGenerationHistory"
          :label="t('save.export.images.includeHistory')"
          show-label
          @update:model-value="() => toggle('includedGenerationHistory')"
        />
      </div>
      <div class="ckl-toggle">
        <AgaToggle
          :model-value="modelValue.includedReferenceGallery"
          :label="t('save.export.images.includeGallery')"
          show-label
          @update:model-value="() => toggle('includedReferenceGallery')"
        />
      </div>
    </div>

    <!-- Content rating -->
    <div class="ckl-toggle ckl-toggle--nsfw">
      <AgaToggle
        :model-value="modelValue.containsNsfw"
        :label="t('save.export.images.nsfw')"
        show-label
        @update:model-value="() => toggle('containsNsfw')"
      />
    </div>
  </div>
</template>

<style scoped>
.ckl-core {
  padding: 10px 12px;
  margin-bottom: 14px;
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border-radius: var(--radius-md);
}
.ckl-core__title {
  margin: 0 0 2px;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text);
}
.ckl-core__body {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}

.ckl-group-title {
  margin: 14px 0 6px;
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

.ckl-list { display: flex; flex-direction: column; gap: 3px; }

.ckl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  font-size: 0.88rem;
  color: var(--color-text);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
@media (hover: hover) {
  .ckl-row:hover { background: color-mix(in oklch, var(--color-text) 4%, transparent); }
}
.ckl-toggle {
  display: flex;
  align-items: center;
  padding: 5px 4px;
}
.ckl-toggle--nsfw {
  margin-top: 12px;
}
.ckl-toggle--nsfw :deep(.aga-toggle-labeled__text) {
  color: var(--color-amber-400);
}
.ckl-box {
  width: 16px;
  height: 16px;
  accent-color: var(--color-sage-400);
  cursor: pointer;
  flex-shrink: 0;
}
.ckl-label { flex: 1; }
.ckl-static {
  margin: 0;
  padding: 5px 4px;
  font-size: 0.88rem;
  color: var(--color-text-secondary);
}
.ckl-info {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary);
  background: color-mix(in oklch, var(--color-text) 10%, transparent);
  border-radius: var(--radius-full);
  cursor: help;
}
</style>
