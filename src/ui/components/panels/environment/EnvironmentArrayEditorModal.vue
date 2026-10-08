<script setup lang="ts">
/**
 * Environment array editor — quick-action for `世界.环境`.
 *
 * Shows a list of current env tags with delete icons. "添加" button opens
 * an inline form for a new tag (名称/描述/效果). Cap at 3 tags (enforced
 * both in UI and in the builder). On apply, emits the full replacement
 * array.
 *
 * Matches the P2 force-update convention: AssistantPanel fires
 * `set 世界.环境 = [the user's array]`, not push/delete.
 */
import { ref, watch, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/shared/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import {
  buildReplaceEnvironmentAttachment,
  type EnvTag,
} from '../assistant-env-attachments';

const { t } = useI18n();

const props = defineProps<{
  modelValue: boolean;
  /** Current env tag array — seeded on open for incremental editing. */
  current?: EnvTag[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  apply: [tags: EnvTag[]];
}>();

const MAX_TAGS = 3;

const tags = ref<EnvTag[]>([]);
const error = ref('');

// Form state for adding a new tag
const showForm = ref(false);
const newName = ref('');
const newDesc = ref('');
const newEffect = ref('');
const newNameInputRef = ref<HTMLInputElement | null>(null);

function clearError(): void {
  if (error.value) error.value = '';
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      tags.value = (props.current ?? []).map((t) => ({ ...t }));
      error.value = '';
      showForm.value = false;
      newName.value = '';
      newDesc.value = '';
      newEffect.value = '';
    }
  },
);

const canAdd = computed(() => tags.value.length < MAX_TAGS);

function beginAdd(): void {
  if (!canAdd.value) return;
  showForm.value = true;
  newName.value = '';
  newDesc.value = '';
  newEffect.value = '';
  nextTick(() => newNameInputRef.value?.focus());
}

function confirmAdd(): void {
  const trimmedName = newName.value.trim();
  if (!trimmedName) {
    error.value = '新标签的名称不能为空';
    return;
  }
  if (tags.value.length >= MAX_TAGS) {
    error.value = `最多 ${MAX_TAGS} 条环境标签`;
    return;
  }
  tags.value.push({
    名称: trimmedName,
    描述: newDesc.value.trim(),
    效果: newEffect.value.trim(),
  });
  showForm.value = false;
  error.value = '';
}

function cancelAdd(): void {
  showForm.value = false;
  error.value = '';
}

function removeTag(index: number): void {
  tags.value.splice(index, 1);
  error.value = '';
}

function clearAll(): void {
  tags.value = [];
  error.value = '';
}

function onApply(): void {
  const result = buildReplaceEnvironmentAttachment(tags.value);
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
    title="编辑环境标签"
    width="520px"
    @update:model-value="(v) => emit('update:modelValue', v)"
  >
    <div class="env-editor">
      <div class="editor-header">
        <span class="count-label">
          当前 {{ tags.length }}/{{ MAX_TAGS }} 条
        </span>
        <AgaButton
          v-if="tags.length > 0"
          variant="ghost"
          size="sm"
          @click="clearAll"
        >
          全部清空
        </AgaButton>
      </div>

      <ul v-if="tags.length > 0" class="tag-list">
        <li v-for="(tag, i) in tags" :key="`${i}-${tag.名称}`" class="tag-item">
          <div class="tag-body">
            <div class="tag-name">{{ tag.名称 }}</div>
            <div v-if="tag.描述" class="tag-desc">{{ tag.描述 }}</div>
            <div v-if="tag.效果" class="tag-effect">{{ tag.效果 }}</div>
          </div>
          <Tooltip :text="t('common.actions.delete')" interactive>
            <button
              type="button"
              class="tag-remove"
              @click="removeTag(i)"
              :aria-label="t('common.actions.delete')"
            >
              ×
            </button>
          </Tooltip>
        </li>
      </ul>
      <p v-else class="empty-state">（暂无环境标签 · 应用后将清空）</p>

      <div v-if="showForm" class="add-form">
        <input
          ref="newNameInputRef"
          v-model="newName"
          class="form-input"
          placeholder="名称（必填，4 CJK 优选）"
          @input="clearError"
          @keydown.enter="confirmAdd"
        />
        <input
          v-model="newDesc"
          class="form-input"
          placeholder="描述（可空，12-25 字）"
          @keydown.enter="confirmAdd"
        />
        <input
          v-model="newEffect"
          class="form-input"
          placeholder="效果（可空，机械措辞）"
          @keydown.enter="confirmAdd"
        />
        <div class="form-actions">
          <AgaButton variant="ghost" size="sm" @click="cancelAdd">取消</AgaButton>
          <AgaButton variant="primary" size="sm" @click="confirmAdd">添加</AgaButton>
        </div>
      </div>
      <AgaButton
        v-else
        variant="secondary"
        class="add-btn"
        :disabled="!canAdd"
        @click="beginAdd"
      >
        + 添加标签 {{ canAdd ? '' : `(已达 ${MAX_TAGS} 条上限)` }}
      </AgaButton>

      <p v-if="error" class="editor-error">{{ error }}</p>
    </div>

    <template #footer>
      <AgaButton variant="secondary" @click="onCancel">取消</AgaButton>
      <AgaButton variant="primary" @click="onApply">应用</AgaButton>
    </template>
  </Modal>
</template>

<style scoped>
.env-editor {
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.count-label {
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}
.tag-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0;
  margin: 0;
  list-style: none;
}
.tag-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border);
  box-shadow: inset 3px 0 0 color-mix(in oklch, var(--color-sage-400) 35%, transparent),
              inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
  border-radius: 4px;
  background: linear-gradient(135deg,
    color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface)),
    var(--color-surface));
}
.tag-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}
.tag-name {
  font-weight: 600;
  font-size: 0.88rem;
  color: var(--color-sage-300);
}
.tag-desc {
  font-size: 0.75rem;
  opacity: 0.8;
}
.tag-effect {
  font-size: 0.7rem;
  color: color-mix(in oklch, var(--color-success) 85%, transparent);
  font-style: italic;
}
.tag-remove {
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0 0.3rem;
  line-height: 1;
}
.tag-remove:hover {
  color: var(--color-danger);
}
.empty-state {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  text-align: center;
  padding: 0.5rem;
  margin: 0;
}
.add-btn {
  width: 100%;
  border-style: dashed;
}
.add-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.6rem;
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: var(--radius-md);
}
.form-input {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-input);
  color: var(--color-text);
  font-size: 0.82rem;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.form-input::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
  font-style: italic;
}
.form-input:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-input));
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}
.form-actions {
  display: flex;
  gap: 0.4rem;
  justify-content: flex-end;
}
.editor-error {
  color: var(--color-danger);
  font-size: 0.78rem;
  margin: 0;
}
</style>
