<script setup lang="ts">
/**
 * Weather picker modal — quick-action input for `世界.天气`.
 *
 * Free text input + preset buttons. Emits `apply` with the validated
 * weather string. Parent (AssistantPanel) fires the actual state write.
 *
 * Polanyi: minimal form. User should change weather in < 3 seconds.
 */
import { ref, watch, nextTick } from 'vue';
import Modal from '@/ui/components/shared/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import {
  buildSetWeatherAttachment,
  WEATHER_PRESETS,
} from '../assistant-env-attachments';

const props = defineProps<{
  modelValue: boolean;
  /** Current weather value to seed the input (P4 UX). */
  current?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  apply: [weather: string];
}>();

const input = ref('');
const error = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

// Seed input when the modal opens so editing is incremental.
// Also autofocus the text field (Modal.vue only focuses its container div;
// we want the user to type immediately).
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      input.value = props.current ?? '';
      error.value = '';
      nextTick(() => inputRef.value?.focus());
    }
  },
);

function pickPreset(preset: string): void {
  input.value = preset;
  error.value = '';
}

function onInputChange(): void {
  // Clear stale error when user edits — they're trying to fix it
  if (error.value) error.value = '';
}

function onApply(): void {
  const result = buildSetWeatherAttachment(input.value);
  if (!result.ok) {
    error.value = result.reason;
    return;
  }
  emit('apply', result.value);
  emit('update:modelValue', false);
}

function onCancel(): void {
  emit('update:modelValue', false);
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    title="设置天气"
    width="400px"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="weather-picker">
      <label class="picker-label">天气名</label>
      <input
        ref="inputRef"
        v-model="input"
        type="text"
        class="picker-input"
        placeholder="例：晴 / 暴雨 / 大雾"
        @input="onInputChange"
        @keydown.enter="onApply"
      />

      <div class="picker-presets">
        <span class="presets-label">预设：</span>
        <button
          v-for="preset in WEATHER_PRESETS"
          :key="preset"
          type="button"
          class="preset-btn"
          :class="{ 'is-active': input === preset }"
          @click="pickPreset(preset)"
        >
          {{ preset }}
        </button>
      </div>

      <p v-if="error" class="picker-error">{{ error }}</p>
    </div>

    <template #footer>
      <AgaButton variant="secondary" @click="onCancel">取消</AgaButton>
      <AgaButton variant="primary" @click="onApply">应用</AgaButton>
    </template>
  </Modal>
</template>

<style scoped>
.weather-picker {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.picker-label {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.picker-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 0.9rem;
}
.picker-input:focus {
  outline: none;
  border-color: var(--color-amber-400);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-amber-400) 12%, transparent);
}
.picker-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
.presets-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-right: 0.2rem;
}
.preset-btn {
  padding: 0.25rem 0.65rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-size: 0.78rem;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.preset-btn:hover {
  border-color: var(--color-primary);
}
.preset-btn.is-active {
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-amber-400) 12%, transparent),
    color-mix(in oklch, var(--color-amber-400) 6%, transparent));
  border-color: var(--color-primary);
  color: var(--color-primary);
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-amber-400) 15%, transparent);
}
.picker-error {
  color: var(--color-danger);
  font-size: 0.78rem;
  margin: 0;
}
</style>
