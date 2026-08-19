<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.7
/**
 * CustomPresetModal — 用户自定义创角预设的填写表单
 *
 * 使用场景（2026-04-14 Phase 2）：
 * - StepSelectOne / StepSelectMany 的"+ 自定义"按钮触发新增
 * - 现有 user 项的"编辑 ✏"按钮触发编辑（带 initialData）
 *
 * 字段定义来自 creation-flow.json 中 step.customSchema.fields，
 * 每个字段渲染对应原生输入框（text / textarea / number），
 * 提交前校验 required + number 的 min/max。
 *
 * 校验失败时显示错误列表，不关闭 modal。
 * 校验通过 → emit `submit` 把 fields 对象传给父组件 → 父组件调
 * useCreationFlow.addCustomPreset / updateCustomPreset 落盘。
 */
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import type { CustomPresetSchema } from '@/engine/types';
import {
  buildCustomPresetFormData,
  normalizeCustomPresetFormData,
  validateCustomPresetForm,
} from '@/engine/creation/custom-preset-form';

const { t } = useI18n();

const props = withDefaults(defineProps<{
  /** 控制显示（v-model:modelValue） */
  modelValue: boolean;
  /** 标题，区分新增 vs 编辑 */
  title: string;
  /** 字段 schema —— 决定渲染哪些输入 */
  schema: CustomPresetSchema;
  /** 编辑模式：传入已有 entry 的字段值；新增模式留空 */
  initialData?: Record<string, unknown>;
  /** 保存按钮 loading 态（外部决定，例如等 IDB 写入或 AI 生成中） */
  saving?: boolean;
}>(), {
  initialData: undefined,
  saving: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** 校验通过后提交字段对象（不含 id/source/createdAt —— 由 store 补） */
  submit: [fields: Record<string, unknown>];
}>();

// ─── Form state ────────────────────────────────────────────

const formData = ref<Record<string, unknown>>({});
const errors = ref<string[]>([]);

/** 打开 / initialData 变化时重置表单 */
watch(
  () => [props.modelValue, props.initialData] as const,
  ([open, init]) => {
    if (!open) return;
    formData.value = buildCustomPresetFormData(props.schema, init);
    errors.value = [];
  },
  { immediate: true },
);

/**
 * 初始化表单值
 * - 编辑模式：从 initialData 中按 schema 字段 key 取值
 * - 新增模式：每个字段填默认值（number = 0 或 default，其他 = ''）
 */
// ─── Validation ────────────────────────────────────────────

function validate(): boolean {
  const issues = validateCustomPresetForm(props.schema, formData.value);
  errors.value = issues.map((issue) => {
    if (issue.type === 'min') return t('creation.customPreset.minError', { label: issue.label, min: issue.limit });
    if (issue.type === 'max') return t('creation.customPreset.maxError', { label: issue.label, max: issue.limit });
    if (issue.type === 'number') return t('creation.customPreset.numberError', { label: issue.label });
    return t('creation.customPreset.requiredError', { label: issue.label });
  });
  return issues.length === 0;
}

// ─── Actions ───────────────────────────────────────────────

function close(): void {
  emit('update:modelValue', false);
}

function submit(): void {
  if (!validate()) return;
  emit('submit', normalizeCustomPresetFormData(props.schema, formData.value));
}

// ─── Computed ──────────────────────────────────────────────

const submitDisabled = computed(() => props.saving);

/**
 * v-model 类型适配 —— 把 unknown 包装成 string，避免 vue-tsc 抱怨
 * formData[key] 是 unknown（schema-driven 字段无静态类型）
 */
function getVal(key: string): string {
  const v = formData.value[key];
  return v === null || v === undefined ? '' : String(v);
}
function setVal(key: string, v: string): void {
  formData.value[key] = v;
}
function getSelectVal(key: string): string {
  const value = formData.value[key];
  return Array.isArray(value) ? String(value[0] ?? '') : getVal(key);
}
function getChecked(key: string): boolean {
  return formData.value[key] === true;
}
function setChecked(key: string, value: boolean): void {
  formData.value[key] = value;
}
</script>

<template>
  <Modal :model-value="modelValue" :title="title" width="500px" @update:model-value="(v: boolean) => emit('update:modelValue', v)">
    <div class="custom-preset-form">
      <div v-for="field in schema.fields" :key="field.key" class="form-row">
        <label :for="`fld-${field.key}`" class="form-label">
          {{ field.label }}
          <span v-if="field.required" class="required-mark">*</span>
        </label>

        <input
          v-if="field.type === 'text'"
          :id="`fld-${field.key}`"
          :value="getVal(field.key)"
          type="text"
          :placeholder="field.placeholder"
          class="form-input"
          @input="setVal(field.key, ($event.target as HTMLInputElement).value)"
        />

        <textarea
          v-else-if="field.type === 'textarea'"
          :id="`fld-${field.key}`"
          :value="getVal(field.key)"
          :placeholder="field.placeholder"
          :rows="field.rows ?? 4"
          class="form-textarea"
          @input="setVal(field.key, ($event.target as HTMLTextAreaElement).value)"
        />

        <input
          v-else-if="field.type === 'number'"
          :id="`fld-${field.key}`"
          :value="getVal(field.key)"
          type="number"
          :placeholder="field.placeholder"
          :min="field.min"
          :max="field.max"
          class="form-input form-input--number"
          @input="setVal(field.key, ($event.target as HTMLInputElement).value)"
        />

        <select
          v-else-if="field.type === 'select'"
          :id="`fld-${field.key}`"
          :value="getSelectVal(field.key)"
          class="form-input"
          @change="setVal(field.key, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in field.options ?? []" :key="option" :value="option">{{ option }}</option>
        </select>

        <input
          v-else-if="field.type === 'checkbox'"
          :id="`fld-${field.key}`"
          :checked="getChecked(field.key)"
          type="checkbox"
          class="form-checkbox"
          @change="setChecked(field.key, ($event.target as HTMLInputElement).checked)"
        />
      </div>

      <ul v-if="errors.length" class="form-errors">
        <li v-for="(err, i) in errors" :key="i">{{ err }}</li>
      </ul>
    </div>

    <template #footer>
      <AgaButton variant="secondary" :disabled="saving" @click="close">{{ $t('creation.customPreset.cancel') }}</AgaButton>
      <AgaButton variant="primary" :disabled="submitDisabled" :loading="saving" @click="submit">
        {{ saving ? $t('creation.customPreset.saving') : $t('creation.customPreset.save') }}
      </AgaButton>
    </template>
  </Modal>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Hardcoded rgba input bg (`rgba(255,255,255,0.04)`) → tokenized surface-input
   - Focus: raw indigo border → sage 3px ring + sage 3% wash (matches StepForm)
   - form-errors: Tailwind rgba rust + `#fca5a5` → tokenized color-mix
   DS migration 2026-06-30: footer buttons → <AgaButton> (one button source
   of truth); dead .btn/.btn-spinner CSS removed. */

.custom-preset-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.form-label {
  font-family: var(--font-sans);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
}

.required-mark {
  color: color-mix(in oklch, var(--color-danger) 90%, var(--color-text));
  margin-left: 3px;
}

.form-input,
.form-textarea {
  padding: 9px 12px;
  background: var(--color-surface-input);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-serif-cjk);
  font-size: 0.86rem;
  line-height: 1.6;
  letter-spacing: 0.01em;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.form-input::placeholder,
.form-textarea::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
  font-style: italic;
}
.form-input:focus,
.form-textarea:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-input));
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 12%, transparent);
}
.form-textarea {
  resize: vertical;
  min-height: 90px;
}
.form-input--number {
  max-width: 140px;
  font-family: var(--font-mono);
}
.form-checkbox {
  width: 20px;
  height: 20px;
  accent-color: var(--color-sage-400);
}

.form-errors {
  margin: 6px 0 0;
  padding: 10px 14px 10px 30px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent);
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
  font-family: var(--font-sans);
  font-size: 0.76rem;
  line-height: 1.7;
  letter-spacing: 0.02em;
  list-style: '• ';
  box-shadow: inset 0 0 10px color-mix(in oklch, var(--color-danger) 6%, transparent);
}
.form-errors li { padding-left: 4px; }
</style>
