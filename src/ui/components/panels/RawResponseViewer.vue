<script setup lang="ts">
/**
 * RawResponseViewer — readonly display of the raw AI response text for a
 * given round. For split-gen rounds, shows two tabs:
 *   - Step 1 (narrative) from `_rawResponse`
 *   - Step 2 (structured) from `_rawResponseStep2`
 * For single-call rounds, one tab labeled "原始响应".
 *
 * Phase 3 (2026-04-19): readonly. Phase 5 will add editable + re-parse
 * capability (gated to latest turn only).
 *
 * Data source: narrativeHistory[i]._rawResponse + ._rawResponseStep2 (Phase 1).
 */
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';

interface Props {
  modelValue: boolean;
  step1?: string | null;
  step2?: string | null;
  roundNumber?: number;
}

const props = withDefaults(defineProps<Props>(), {
  step1: '',
  step2: '',
  roundNumber: 0,
});

defineEmits<{
  'update:modelValue': [value: boolean];
}>();

const { t } = useI18n();

const isSplitGen = computed(() => !!props.step2 && props.step2.length > 0);
type Tab = 'step1' | 'step2';
const activeTab = ref<Tab>('step1');

// Reset tab when reopened — users may open different rounds with different
// split-gen state; force step1 on each open.
watch(
  () => props.modelValue,
  (open) => {
    if (open) activeTab.value = 'step1';
  },
);

const displayText = computed(() => {
  if (activeTab.value === 'step2') return props.step2 ?? '';
  return props.step1 ?? '';
});

function title(): string {
  return props.roundNumber > 0
    ? t('mainGame.rawViewer.title', { n: props.roundNumber })
    : t('mainGame.rawViewer.titleGeneric');
}
</script>

<template>
  <Modal
    :model-value="props.modelValue"
    :title="title()"
    width="800px"
    backdrop-close
    @update:model-value="(v) => $emit('update:modelValue', v)"
  >
    <!-- Tab switcher — only when split-gen has two payloads -->
    <div v-if="isSplitGen" class="raw-viewer__tabs" role="tablist">
      <button
        class="raw-viewer__tab"
        :class="{ 'raw-viewer__tab--active': activeTab === 'step1' }"
        role="tab"
        :aria-selected="activeTab === 'step1'"
        @click="activeTab = 'step1'"
      >
        {{ $t('mainGame.rawViewer.tabStep1') }}
      </button>
      <button
        class="raw-viewer__tab"
        :class="{ 'raw-viewer__tab--active': activeTab === 'step2' }"
        role="tab"
        :aria-selected="activeTab === 'step2'"
        @click="activeTab = 'step2'"
      >
        {{ $t('mainGame.rawViewer.tabStep2') }}
      </button>
    </div>

    <textarea
      class="raw-viewer__body"
      readonly
      :value="displayText"
      :aria-label="$t('mainGame.rawViewer.textareaLabel')"
    />

    <p v-if="!displayText || displayText.length === 0" class="raw-viewer__empty">
      {{ $t('mainGame.rawViewer.empty') }}
    </p>
  </Modal>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Tab active indigo → sage-300 text + sage-400 underline (matches CommandsViewer)
   - Body plate-black rgba(0,0,0,0.4) → tokenized warm-charcoal wash
   - Terminal-green `#86efac` (Tailwind emerald-300) → sage-300 so raw text
     reads as "instrument readout" rather than hacker-terminal neon
   - Focus: indigo ring → sage ring matching all other focus states */

.raw-viewer__tabs {
  display: flex;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--color-border-subtle);
}

.raw-viewer__tab {
  padding: var(--space-xs) var(--space-md);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-family: var(--font-sans);
  font-size: var(--font-size-xs);
  font-weight: 500;
  letter-spacing: 0.06em;
  cursor: pointer;
  margin-bottom: -1px;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out);
}

.raw-viewer__tab:hover {
  color: var(--color-text);
}

.raw-viewer__tab--active {
  color: var(--color-sage-300);
  border-bottom-color: var(--color-sage-400);
}

.raw-viewer__body {
  display: block;
  width: 100%;
  min-height: 360px;
  max-height: 60vh;
  padding: var(--space-md) var(--space-lg);
  background: color-mix(in oklch, var(--color-bg) 78%, transparent);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  color: var(--color-sage-300);
  font-family: var(--font-mono, 'Consolas', monospace);
  font-size: 0.75rem;
  line-height: 1.55;
  resize: vertical;
  outline: none;
  white-space: pre;
  overflow: auto;
  transition: border-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.raw-viewer__body:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.raw-viewer__empty {
  margin: var(--space-md) 0 0;
  text-align: center;
  color: var(--color-text-muted);
  font-family: var(--font-serif-cjk);
  font-style: italic;
}
</style>
