<script setup lang="ts">
/**
 * Festival editor modal — quick-action input for `世界.节日`.
 *
 * 3 inputs (名称 / 描述 / 效果) + "恢复平日" preset button. Parent receives
 * the validated `{名称,描述,效果}` object via `apply` event.
 */
import { ref, watch, nextTick } from 'vue';
import Modal from '@/ui/components/shared/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import {
  buildSetFestivalAttachment,
  type EnvTag,
} from '../assistant-env-attachments';

const props = defineProps<{
  modelValue: boolean;
  current?: { 名称?: string; 描述?: string; 效果?: string };
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  apply: [festival: EnvTag];
}>();

const name = ref('');
const desc = ref('');
const effect = ref('');
const error = ref('');
const nameInputRef = ref<HTMLInputElement | null>(null);

// Autofocus primary input on open + clear stale error on any input edit.
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      name.value = props.current?.名称 ?? '';
      desc.value = props.current?.描述 ?? '';
      effect.value = props.current?.效果 ?? '';
      error.value = '';
      nextTick(() => nameInputRef.value?.focus());
    }
  },
);

function onInputChange(): void {
  if (error.value) error.value = '';
}

function resetToPingRi(): void {
  name.value = '平日';
  desc.value = '';
  effect.value = '';
  error.value = '';
}

function onApply(): void {
  const result = buildSetFestivalAttachment({
    名称: name.value,
    描述: desc.value,
    效果: effect.value,
  });
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
    title="设置节日"
    width="440px"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="festival-edit">
      <label class="field">
        <span class="field-label">名称</span>
        <input
          ref="nameInputRef"
          v-model="name"
          class="field-input"
          placeholder="例：元宵节 / 中秋 / 平日"
          @input="onInputChange"
          @keydown.enter="onApply"
        />
      </label>
      <label class="field">
        <span class="field-label">描述（可空）</span>
        <input
          v-model="desc"
          class="field-input"
          placeholder="街景氛围，1 句"
          @input="onInputChange"
          @keydown.enter="onApply"
        />
      </label>
      <label class="field">
        <span class="field-label">效果（可空）</span>
        <input
          v-model="effect"
          class="field-input"
          placeholder="机械 / 叙事影响"
          @input="onInputChange"
          @keydown.enter="onApply"
        />
      </label>

      <div class="preset-row">
        <AgaButton variant="ghost" size="sm" @click="resetToPingRi">恢复为平日（无节日）</AgaButton>
      </div>

      <p v-if="error" class="field-error">{{ error }}</p>
    </div>

    <template #footer>
      <AgaButton variant="secondary" @click="onCancel">取消</AgaButton>
      <AgaButton variant="primary" @click="onApply">应用</AgaButton>
    </template>
  </Modal>
</template>

<style scoped>
.festival-edit {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.field-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.field-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 0.88rem;
}
.field-input:focus {
  outline: 1px solid var(--color-primary);
  outline-offset: 1px;
}
.preset-row {
  display: flex;
  justify-content: flex-end;
}
.field-error {
  color: var(--color-danger);
  font-size: 0.78rem;
  margin: 0;
}
</style>
