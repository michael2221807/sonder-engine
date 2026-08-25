<script setup lang="ts">
/**
 * ThinkingViewer — readonly display of the AI's CoT reasoning captured from
 * `<thinking>...</thinking>` blocks of a given round. Wraps the common Modal.
 *
 * Data source: `narrativeHistory[i]._thinking` on assistant entries (Phase 1).
 * Phase 3 (2026-04-19): opened from the 🌐 button on RoundDivider's left slot
 * and from the existing PromptAssembly panel's CoT reference button.
 *
 * Principle: the modal only *displays* — no editing. Edit flow belongs to
 * Phase 5's raw-response editor, which rewrites the full parser input.
 */
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';

const { t } = useI18n();

interface Props {
  /** v-model for Modal visibility. */
  modelValue: boolean;
  /** The CoT text. Empty / null / undefined → shows "（本回合无思考）". */
  text?: string | null;
  /** Round number for title, purely cosmetic. */
  roundNumber?: number;
}

const props = withDefaults(defineProps<Props>(), {
  text: '',
  roundNumber: 0,
});

defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function title(): string {
  return props.roundNumber > 0
    ? t('mainGame.thinkingViewer.title', { n: props.roundNumber })
    : t('mainGame.thinkingViewer.titleGeneric');
}
</script>

<template>
  <Modal
    :model-value="props.modelValue"
    :title="title()"
    width="720px"
    backdrop-close
    @update:model-value="(v) => $emit('update:modelValue', v)"
  >
    <pre v-if="props.text && props.text.trim().length > 0" class="thinking-viewer__body">{{ props.text }}</pre>
    <p v-else class="thinking-viewer__empty">{{ $t('mainGame.thinkingViewer.empty') }}</p>
  </Modal>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Plate-black rgba(0,0,0,0.3) → tokenized warm-charcoal wash via color-mix
   - Global sanctuary scrollbar (tokens.css *::-webkit-scrollbar) handles thumb;
     local override removed so thumb color stays consistent with rest of app
   - Empty state: CJK serif italic, umber-muted — matches "subsidiary awareness" */

.thinking-viewer__body {
  font-family: var(--font-mono, 'Consolas', monospace);
  font-size: 0.78rem;
  line-height: 1.65;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 60vh;
  overflow-y: auto;
  margin: 0;
  padding: var(--space-md) var(--space-lg);
  background: color-mix(in oklch, var(--color-bg) 70%, transparent);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
}

.thinking-viewer__empty {
  margin: 0;
  padding: var(--space-2xl) 0;
  text-align: center;
  color: var(--color-text-muted);
  font-family: var(--font-serif-cjk);
  font-style: italic;
}
</style>
