<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.6
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import AgaButton from '@/ui/components/shared/AgaButton.vue';

const { t } = useI18n();

const props = defineProps<{
  currentPhase: string | null;
  currentProgress: number;
  streamText: string;
  rateLimitWaitSeconds: number | null;
}>();

const emit = defineEmits<{
  cancel: [];
}>();

interface PhaseItem {
  key: string;
  label: string;
}

const phases: PhaseItem[] = [
  { key: 'phaseA', label: 'progress.enhancedOpening.phaseA' },
  { key: 'phaseB', label: 'progress.enhancedOpening.phaseB' },
  { key: 'phaseC', label: 'progress.enhancedOpening.phaseC' },
  { key: 'phaseD', label: 'progress.enhancedOpening.phaseD' },
  { key: 'phaseE', label: 'progress.enhancedOpening.phaseE' },
  { key: 'phaseF', label: 'progress.enhancedOpening.phaseF' },
  { key: 'phaseG', label: 'progress.enhancedOpening.phaseG' },
];

const currentIndex = computed(() => {
  if (!props.currentPhase) return -1;
  return phases.findIndex(p => p.key === props.currentPhase);
});

const overallProgress = computed(() => {
  if (currentIndex.value < 0) return 0;
  const baseProgress = (currentIndex.value / phases.length) * 100;
  const phaseContribution = (props.currentProgress / phases.length);
  return Math.min(Math.round(baseProgress + phaseContribution), 100);
});

function getPhaseStatus(index: number): 'done' | 'active' | 'pending' {
  if (currentIndex.value < 0) return 'pending';
  if (index < currentIndex.value) return 'done';
  if (index === currentIndex.value) return 'active';
  return 'pending';
}

const showStreamPreview = computed(() =>
  props.currentPhase === 'phaseE' && props.streamText.length > 0,
);

const isRateLimitWaiting = computed(() =>
  props.rateLimitWaitSeconds !== null && props.rateLimitWaitSeconds > 0,
);
</script>

<template>
  <div class="enhanced-opening-progress">
    <h3 class="progress-title">{{ t('progress.enhancedOpening.title') }}</h3>

    <div class="phase-list">
      <template v-for="(phase, i) in phases" :key="phase.key">
        <div v-if="isRateLimitWaiting && getPhaseStatus(i) === 'active'" class="phase-item rate-limit-wait">
          <span class="phase-icon">&#9203;</span>
          <span class="phase-label">{{ t('progress.enhancedOpening.rateLimitWait', { seconds: rateLimitWaitSeconds }) }}</span>
        </div>
        <div
          class="phase-item"
          :class="getPhaseStatus(i)"
        >
          <span class="phase-icon">
            <template v-if="getPhaseStatus(i) === 'done'">&#10003;</template>
            <template v-else-if="getPhaseStatus(i) === 'active'">&#9679;</template>
            <template v-else>&#9675;</template>
          </span>
          <span class="phase-label">{{ t(phase.label) }}</span>
        </div>
      </template>
    </div>

    <div v-if="showStreamPreview" class="stream-preview">
      <div class="stream-preview-text">{{ streamText }}</div>
    </div>

    <div class="progress-bar-track">
      <div
        class="progress-bar-fill"
        :style="{ width: overallProgress + '%' }"
      />
    </div>
    <div class="progress-percent">{{ overallProgress }}%</div>

    <AgaButton variant="ghost" @click="emit('cancel')">
      {{ t('progress.enhancedOpening.cancel') }}
    </AgaButton>
  </div>
</template>

<style scoped>
.enhanced-opening-progress {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 2rem;
  max-width: 480px;
  margin: 0 auto;
}

.progress-title {
  font-size: 1.1rem;
  color: var(--color-text);
  margin: 0;
}

.phase-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}

.phase-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  transition: color 0.3s, opacity 0.3s;
}

.phase-item.done {
  color: var(--color-success);
}

.phase-item.active {
  color: var(--color-text);
  font-weight: 500;
}

.phase-item.pending {
  opacity: 0.5;
}

.phase-item.rate-limit-wait {
  color: var(--color-warning);
  font-size: 0.82rem;
  font-style: italic;
  animation: pulse-wait 1.5s ease-in-out infinite;
}

@keyframes pulse-wait {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

.phase-icon {
  width: 1.2rem;
  text-align: center;
  flex-shrink: 0;
}

.stream-preview {
  width: 100%;
  max-height: 200px;
  overflow-y: auto;
  padding: 0.75rem;
  border-radius: 8px;
  background: var(--glass-bg, rgba(255, 255, 255, 0.04));
  backdrop-filter: var(--glass-blur, blur(24px) saturate(1.4));
  font-size: 0.85rem;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.stream-preview-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.progress-bar-track {
  width: 100%;
  height: 4px;
  border-radius: 2px;
  background: var(--color-surface-elevated);
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--color-sage-400);
  transition: width 0.4s ease;
}

.progress-percent {
  font-size: 0.8rem;
  color: var(--color-text-muted);
}
</style>
