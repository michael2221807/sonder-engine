<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.6
import { useI18n } from 'vue-i18n';
import type { PhaseErrorAction } from '@/engine/pipeline/sub-pipelines/enhanced-opening';

const { t } = useI18n();

defineProps<{
  phase: string;
  reason: string;
  availableActions: PhaseErrorAction[];
}>();

const emit = defineEmits<{
  action: [action: PhaseErrorAction];
}>();

const phaseLabels: Record<string, string> = {
  A: 'progress.enhancedOpening.phaseA',
  B: 'progress.enhancedOpening.phaseB',
  C: 'progress.enhancedOpening.phaseC',
  D: 'progress.enhancedOpening.phaseD',
  E: 'progress.enhancedOpening.phaseE',
  F: 'progress.enhancedOpening.phaseF',
  G: 'progress.enhancedOpening.phaseG',
};

const actionLabels: Record<PhaseErrorAction, string> = {
  retry: 'creation.enhancedOpening.failDialog.retry',
  rollback: 'creation.enhancedOpening.failDialog.rollback',
  exit: 'creation.enhancedOpening.failDialog.exit',
};
</script>

<template>
  <div class="fail-dialog-backdrop">
    <div class="fail-dialog">
      <div class="fail-icon">&#9888;</div>
      <h3 class="fail-title">{{ t('creation.enhancedOpening.failDialog.title') }}</h3>
      <p class="fail-phase">{{ t(phaseLabels[phase] ?? phase) }}</p>
      <p class="fail-reason">{{ reason }}</p>

      <div class="fail-actions">
        <button
          v-for="action in availableActions"
          :key="action"
          class="fail-action-btn"
          :class="action"
          @click="emit('action', action)"
        >
          {{ t(actionLabels[action]) }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fail-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--glass-overlay-bg, rgba(0, 0, 0, 0.6));
  backdrop-filter: var(--glass-overlay-blur, blur(8px));
}

.fail-dialog {
  max-width: 420px;
  width: 90%;
  padding: 2rem 1.75rem;
  border-radius: var(--radius-xl, 12px);
  background: var(--glass-bg, rgba(255, 255, 255, 0.04));
  backdrop-filter: var(--glass-blur, blur(24px) saturate(1.4));
  box-shadow: var(--glass-shadow, 0 4px 24px rgba(0, 0, 0, 0.3));
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.fail-icon {
  font-size: 2rem;
  color: var(--color-warning, #e6a23c);
}

.fail-title {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 1.1rem;
  letter-spacing: 0.06em;
  color: var(--color-text, #e0e0e0);
}

.fail-phase {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  color: var(--color-text-muted, #aaa);
}

.fail-reason {
  margin: 0;
  font-size: 0.8rem;
  color: var(--color-text-umber, #888);
  max-height: 100px;
  overflow-y: auto;
  word-break: break-word;
  line-height: 1.5;
}

.fail-actions {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.75rem;
}

.fail-action-btn {
  padding: 0.625rem 1.5rem;
  border-radius: var(--radius-md, 6px);
  border: 1px solid var(--color-border-subtle, rgba(255, 255, 255, 0.1));
  background: transparent;
  color: var(--color-text-muted, #aaa);
  font-family: var(--font-serif-cjk);
  font-size: 0.86rem;
  letter-spacing: 0.04em;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--duration-fast, 0.2s) var(--ease-out, ease-out),
              color var(--duration-fast, 0.2s) var(--ease-out, ease-out),
              border-color var(--duration-fast, 0.2s) var(--ease-out, ease-out);
}

.fail-action-btn:hover {
  background: color-mix(in oklch, var(--color-surface-elevated) 80%, transparent);
  color: var(--color-text, #e0e0e0);
}

.fail-action-btn.retry {
  border-color: var(--color-sage-400, #d4a574);
  color: var(--color-sage-400, #d4a574);
}

.fail-action-btn.retry:hover {
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.fail-action-btn.exit {
  opacity: 0.7;
}
</style>
