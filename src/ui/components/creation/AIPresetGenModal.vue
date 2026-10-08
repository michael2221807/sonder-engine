<script setup lang="ts">
/**
 * AIPresetGenModal — 用户输入"种子描述"并触发 AI 推演自定义预设
 *
 * 流程（2026-04-14 Phase 3）：
 * 1. 用户在 Step 卡片上点 "✦ AI 生成自定义选项" 按钮 → 父组件打开本模态
 * 2. 本模态显示一个 textarea + "推演" 按钮
 * 3. 用户输入种子（可留空让 AI 自由发挥），点击推演
 * 4. 内部调 `presetAIGenerator.generate(...)`：
 *    - 注入 jailbreak prompt（与主回合同源）
 *    - 用 main usage type 复用主游戏 API 配置
 *    - 解析 JSON 响应
 * 5. 成功 → emit `generated` 把字段对象传给父组件 → 父组件用同字段打开
 *    CustomPresetModal 让用户审阅/编辑 → 保存（generatedBy='ai'）
 * 6. 失败 → modal 内显示错误，textarea 保留供用户重试
 *
 * 全程通过 eventBus 触发 toast 给用户反馈（loading / success / error）。
 */
import { ref, watch, computed } from 'vue';
import { injectService } from '@/ui/injection-keys';
import { useI18n } from 'vue-i18n';
import Modal from '@/ui/components/common/Modal.vue';
import type { CustomPresetSchema } from '@/engine/types';
import { PresetAIGenerator } from '@/engine/services/preset-ai-generator';
import { eventBus } from '@/engine/core/event-bus';

const props = withDefaults(defineProps<{
  modelValue: boolean;
  /** 当前 step 的 preset 类型 key（worlds/origins/...） */
  presetType: string;
  /** 当前 step 的中文 label，例如 "世界" */
  stepLabel: string;
  /** 当前 step 的字段 schema —— 决定 AI 必须返回哪些 key */
  schema: CustomPresetSchema;
}>(), {});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /** AI 生成成功后 emit；payload 是字段对象，父组件用它预填 CustomPresetModal */
  generated: [fields: Record<string, unknown>];
}>();

const { t } = useI18n();

// ─── Dependencies ─────────────────────────────────────────

const aiService = injectService('aiService');
const gamePack = injectService('gamePack', null);
// The prompt page's edits and switches reach the generator's jailbreak (item 2, PO 2026-10-05).
const promptAssembler = injectService('promptAssembler', undefined);

// CR-2026-04-14 P2-3：缓存 generator 实例（aiService/gamePack 在 inject 后稳定）
// 实例本身轻量，但避免每次 click 都 new 一份是良好实践。
const generator = computed(() =>
  aiService ? new PresetAIGenerator(aiService, gamePack, promptAssembler) : null,
);

// ─── State ────────────────────────────────────────────────

const userSeed = ref('');
const isGenerating = ref(false);
const errorMsg = ref<string>('');

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      userSeed.value = '';
      errorMsg.value = '';
      isGenerating.value = false;
    }
  },
);

// ─── Actions ──────────────────────────────────────────────

function close(): void {
  if (isGenerating.value) return; // 推演中不允许关闭
  emit('update:modelValue', false);
}

async function handleGenerate(): Promise<void> {
  if (isGenerating.value) return;
  const gen = generator.value;
  if (!gen) {
    errorMsg.value = t('creation.aiGen.error.serviceNotInit');
    eventBus.emit('ui:toast', { type: 'error', message: errorMsg.value, duration: 2500 });
    return;
  }

  isGenerating.value = true;
  errorMsg.value = '';

  // toast: 推演中
  eventBus.emit('ui:toast', {
    type: 'info',
    message: t('creation.aiGen.toast.generating', { label: props.stepLabel }),
    duration: 2500,
  });

  try {
    const result = await gen.generate({
      presetType: props.presetType,
      stepLabel: props.stepLabel,
      schema: props.schema,
      userSeed: userSeed.value,
    });
    eventBus.emit('ui:toast', {
      type: 'success',
      message: t('creation.aiGen.toast.success'),
      duration: 2500,
    });
    emit('generated', result.fields);
    emit('update:modelValue', false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errorMsg.value = msg;
    eventBus.emit('ui:toast', {
      type: 'error',
      message: t('creation.aiGen.toast.error', { msg: msg.slice(0, 80) }),
      duration: 4000,
    });
  } finally {
    isGenerating.value = false;
  }
}
</script>

<template>
  <Modal
    :model-value="modelValue"
    :title="t('creation.aiGen.title', { label: stepLabel })"
    width="500px"
    :closable="!isGenerating"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div class="ai-preset-gen">
      <p class="hint">
        {{ $t('creation.aiGen.hint') }}
      </p>

      <label class="form-label" for="ai-seed-input">{{ $t('creation.aiGen.seedLabel') }}</label>
      <textarea
        id="ai-seed-input"
        v-model="userSeed"
        class="form-textarea"
        rows="5"
        :placeholder="$t('creation.aiGen.seedPlaceholder')"
        :disabled="isGenerating"
      />

      <p v-if="errorMsg" class="error-msg">⚠ {{ errorMsg }}</p>

      <div class="meta-tip">
        <span>{{ $t('creation.aiGen.apiLabel') }}</span>
        <span>·</span>
        <span>{{ $t('creation.aiGen.jailbreakNote') }}</span>
      </div>
    </div>

    <template #footer>
      <button class="btn btn--secondary" :disabled="isGenerating" @click="close">{{ $t('creation.aiGen.cancel') }}</button>
      <button class="btn btn--primary" :disabled="isGenerating" @click="handleGenerate">
        <span v-if="isGenerating" class="btn-spinner" />
        {{ isGenerating ? $t('creation.aiGen.generatingLabel') : $t('creation.aiGen.generate') }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - Same patterns as CustomPresetModal (sibling form modal)
   - Hint text: CJK serif italic (feels like instructional murmur, not
     a dev docs blurb)
   - error-msg: Tailwind rust → tokenized color-mix
   - Textarea: sanctuary surface-input + sage focus ring + serif body
   - Buttons: sanctuary AgaButton language */

.ai-preset-gen {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hint {
  margin: 0;
  font-family: var(--font-serif-cjk);
  font-size: 0.8rem;
  font-style: italic;
  color: var(--color-text-umber);
  line-height: 1.7;
  letter-spacing: 0.02em;
}

.form-label {
  font-family: var(--font-sans);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  margin-top: 4px;
}

.form-textarea {
  padding: 9px 12px;
  background: var(--color-surface-input);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-family: var(--font-serif-cjk);
  font-size: 0.86rem;
  line-height: 1.7;
  letter-spacing: 0.01em;
  resize: vertical;
  min-height: 110px;
  outline: none;
  transition: border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.form-textarea::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
  font-style: italic;
}
.form-textarea:focus {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-input));
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-sage-400) 12%, transparent),
              inset 0 0 8px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
}

.error-msg {
  margin: 4px 0 0;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: color-mix(in oklch, var(--color-danger) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-danger) 30%, transparent);
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
  font-family: var(--font-sans);
  font-size: 0.76rem;
  line-height: 1.6;
  letter-spacing: 0.02em;
}

.meta-tip {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  opacity: 0.75;
}

/* ── Footer buttons — sanctuary AgaButton language ── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 18px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-family: var(--font-sans);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--color-sage-muted);
  color: var(--color-sage-100);
  border-color: color-mix(in oklch, var(--color-sage-400) 35%, transparent);
}
.btn--primary:not(:disabled):hover {
  background: color-mix(in oklch, var(--color-sage-400) 22%, transparent);
  border-color: var(--color-sage-400);
  box-shadow: 0 0 14px color-mix(in oklch, var(--color-sage-400) 28%, transparent);
}

.btn--secondary {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text-secondary);
}
.btn--secondary:not(:disabled):hover {
  color: var(--color-text);
  background: color-mix(in oklch, var(--color-text) 4%, transparent);
}

.btn-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid color-mix(in oklch, currentColor 30%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: agm-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes agm-spin {
  to { transform: rotate(360deg); }
}
</style>
