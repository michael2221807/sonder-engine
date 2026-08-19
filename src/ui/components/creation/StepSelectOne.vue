<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.2
/**
 * StepSelectOne — 创角步骤：单选。
 *
 * 以卡片网格展示预设列表，用户点击卡片选中一个。
 * 选中卡片高亮显示。如果 step.aiGeneration.enabled 为 true，
 * 额外渲染一个 "AI 生成" 按钮供用户请求 AI 生成自定义条目。
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CreationStep, PresetEntry } from '@/engine/types';
import PresetDetailPanel from './PresetDetailPanel.vue';
import CustomPresetModal from './CustomPresetModal.vue';
import AIPresetGenModal from './AIPresetGenModal.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { canAffordPresetCandidate, type BudgetSummary } from '@/engine/creation/creation-budget';

const { t } = useI18n();

const props = defineProps<{
  /** 当前步骤定义 */
  step: CreationStep;
  /** 该步骤可选的预设数据 */
  presets: unknown[];
  /** 当前选中值 */
  selection: unknown;
  /** 剩余点数预算 */
  budget: number;
  budgetSummary?: BudgetSummary | null;
}>();

const emit = defineEmits<{
  select: [value: unknown];
  /**
   * 2026-04-14：用户保存了一条新自定义/编辑后的 entry → 父组件落盘
   * `generatedBy` 区分手填 ('manual') 还是 AI 推演 ('ai') 来源，影响存档元数据。
   */
  customSave: [payload: {
    fields: Record<string, unknown>;
    editingId: string | null;
    generatedBy: 'manual' | 'ai';
  }];
  /** 2026-04-14：用户请求删除一条 user preset → 父组件确认后落盘 */
  customRemove: [id: string];
}>();

// ─── 2026-04-14：用户自定义预设 modal 状态 ──────────────────────

const customModalOpen = ref(false);
/** 编辑模式下的目标 entry id；新增时为 null */
const editingId = ref<string | null>(null);
/** 编辑模式下传给 modal 的 initialData */
const editingInitial = ref<Record<string, unknown> | undefined>(undefined);

const hasCustomSchema = computed(() => Boolean(props.step.customSchema?.fields?.length));

function openAddModal(): void {
  editingId.value = null;
  editingInitial.value = undefined;
  customModalOpen.value = true;
}

function openEditModal(preset: PresetEntry): void {
  if (preset.source !== 'user' || typeof preset.id !== 'string') return;
  editingId.value = preset.id;
  editingInitial.value = { ...preset };
  customModalOpen.value = true;
}

function handleCustomSubmit(fields: Record<string, unknown>): void {
  emit('customSave', {
    fields,
    editingId: editingId.value,
    generatedBy: aiSourceFlag.value ? 'ai' : 'manual',
  });
  aiSourceFlag.value = false;
  customModalOpen.value = false;
}

function handleRemove(preset: PresetEntry, ev: Event): void {
  // 防止冒泡触发 selectPreset
  ev.stopPropagation();
  if (preset.source !== 'user' || typeof preset.id !== 'string') return;
  if (!window.confirm(t('creation.selectOne.confirmDelete', { name: getDisplayName(preset) }))) return;
  emit('customRemove', preset.id);
}

function handleEdit(preset: PresetEntry, ev: Event): void {
  ev.stopPropagation();
  openEditModal(preset);
}

// ─── 2026-04-14 Phase 3：AI 推演 modal ──────────────────────

const aiGenModalOpen = ref(false);

function openAIGenModal(): void {
  aiGenModalOpen.value = true;
}

/**
 * AI 推演成功 → 用结果预填 CustomPresetModal 让用户审阅/编辑后保存
 * 注意：这里只 emit `customSave`（同手填路径），但 generatedBy 标签由父组件
 * 决定 —— 实际由 useCreationFlow.addCustomPreset 处理时父组件根据 modal 来源
 * 标记。这里用一个简单的"AI 模式"状态告诉父组件这次是 AI 生成的。
 */
function handleAIGenerated(fields: Record<string, unknown>): void {
  // 把 AI 生成的字段塞进 CustomPresetModal 让用户审阅
  editingId.value = null;
  editingInitial.value = fields;
  aiSourceFlag.value = true;
  customModalOpen.value = true;
}

/** 标记本次 customModal 提交是否来自 AI 生成路径（影响 generatedBy 字段） */
const aiSourceFlag = ref(false);

/** 将预设数组安全转为 PresetEntry[] */
const typedPresets = computed<PresetEntry[]>(() =>
  props.presets.map((p) => {
    if (typeof p === 'object' && p !== null) return p as PresetEntry;
    return { name: String(p) } as PresetEntry;
  }),
);

/** 判断某个预设是否被选中 */
function isSelected(preset: PresetEntry): boolean {
  if (props.selection === null || props.selection === undefined) return false;
  if (typeof props.selection === 'object' && props.selection !== null) {
    const sel = props.selection as PresetEntry;
    return (sel.id ?? sel.name) === (preset.id ?? preset.name);
  }
  return props.selection === (preset.id ?? preset.name);
}

/** 获取预设的显示名称 */
function getDisplayName(preset: PresetEntry): string {
  return preset.name ?? preset.label ?? String(preset.id ?? t('creation.selectOne.unnamed'));
}

/** 获取预设的花费值（如存在 costField） */
function getCost(preset: PresetEntry): number | null {
  if (!props.step.costField) return null;
  const raw = preset[props.step.costField];
  return typeof raw === 'number' ? raw : null;
}

/** 选中某个预设 */
function selectPreset(preset: PresetEntry): void {
  if (!canAffordPresetCandidate(props.step, preset, props.selection, props.budgetSummary ?? null)) return;
  emit('select', preset);
}

function isDisabled(preset: PresetEntry): boolean {
  return !canAffordPresetCandidate(props.step, preset, props.selection, props.budgetSummary ?? null);
}

/** 是否启用 AI 生成 */
const aiEnabled = computed(() => props.step.aiGeneration?.enabled === true);

/** 当前悬停的预设条目（用于右侧详情面板） */
const hoveredPreset = ref<PresetEntry | null>(null);

/** 当前选中的预设条目（详情面板回退项：无悬停时显示选中项详情） */
const selectedPreset = computed<PresetEntry | null>(() =>
  typedPresets.value.find((p) => isSelected(p)) ?? null,
);
</script>

<template>
  <div class="step-select-one">
    <div class="step-header">
      <h3 class="step-title">{{ step.label }}</h3>
      <span
        v-if="step.costField && budgetSummary"
        class="budget-badge"
        data-testid="creation-budget-summary"
      >
        {{ $t('creation.confirm.budgetValue', {
          spent: budgetSummary.spent,
          total: budgetSummary.total,
          remaining: budgetSummary.remaining,
        }) }}
      </span>
    </div>

    <div class="step-layout">
      <!-- 左栏：选项卡片列表 -->
      <div class="preset-list">
        <!-- "+ 自定义" 按钮（仅当 step 配置了 customSchema 时显示） -->
        <button
          v-if="hasCustomSchema"
          type="button"
          class="custom-add-btn"
          @click="openAddModal"
        >
          {{ $t('creation.selectOne.addCustom', { label: step.label }) }}
        </button>

        <button
          v-for="(preset, idx) in typedPresets"
          :key="preset.id ?? preset.name ?? idx"
          class="preset-card"
          :class="{ selected: isSelected(preset), disabled: isDisabled(preset), 'preset-card--user': preset.source === 'user' }"
          :disabled="isDisabled(preset)"
          @click="selectPreset(preset)"
          @mouseenter="hoveredPreset = preset"
          @mouseleave="hoveredPreset = null"
        >
          <div class="preset-card-header">
            <span class="preset-name">{{ getDisplayName(preset) }}</span>
            <!-- 2026-04-14：user 项显示徽章 + 编辑/删除按钮 -->
            <div v-if="preset.source === 'user'" class="user-badge-row">
              <Tooltip :text="$t('creation.selectOne.userCustomTooltip')">
                <span class="user-badge">{{ $t('creation.selectOne.customizeStep', { label: '' }) }}</span>
              </Tooltip>
              <Tooltip :text="$t('common.actions.edit')" interactive>
                <button
                  type="button"
                  class="user-action user-action--edit"
                  @click="handleEdit(preset, $event)"
                >✏</button>
              </Tooltip>
              <Tooltip :text="$t('common.actions.delete')" interactive>
                <button
                  type="button"
                  class="user-action user-action--del"
                  @click="handleRemove(preset, $event)"
                >🗑</button>
              </Tooltip>
            </div>
          </div>
          <span v-if="preset.description" class="preset-desc">{{ preset.description }}</span>
          <span v-if="getCost(preset) !== null" class="preset-cost">
            {{ $t('creation.selectOne.cost', { value: getCost(preset) }) }}
          </span>
        </button>

        <!-- AI 生成按钮 —— 仅在 step 配置了 customSchema 且 aiGeneration.enabled 时显示 -->
        <div v-if="aiEnabled && hasCustomSchema" class="ai-section">
          <button class="btn-ai" @click="openAIGenModal">
            {{ $t('creation.selectOne.aiGenButton') }}
          </button>
        </div>
      </div>

      <!-- 右栏：选项详情面板 -->
      <div class="detail-col">
        <PresetDetailPanel
          :item="hoveredPreset ?? selectedPreset"
          :fields="step.detailFields"
          :cost-field="step.costField"
        />
      </div>
    </div>

    <!-- 自定义预设 modal —— 仅在 step 配置了 customSchema 时挂载 -->
    <CustomPresetModal
      v-if="step.customSchema"
      v-model="customModalOpen"
      :title="
        editingId
          ? t('creation.selectOne.editCustom', { label: step.label })
          : aiSourceFlag
          ? t('creation.selectOne.reviewAIGenerated', { label: step.label })
          : t('creation.selectOne.customizeStep', { label: step.label })
      "
      :schema="step.customSchema"
      :initial-data="editingInitial"
      @submit="handleCustomSubmit"
    />

    <!-- AI 推演 modal -->
    <AIPresetGenModal
      v-if="step.customSchema && aiEnabled"
      v-model="aiGenModalOpen"
      :preset-type="step.dataSource?.replace(/^presets\./, '') ?? ''"
      :step-label="step.label"
      :schema="step.customSchema"
      @generated="handleAIGenerated"
    />
  </div>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - 2px border → 1px (per brief "near-invisible 1px tints"); card background
     moves up to surface-elevated for subtle depth
   - Selected: Tailwind rgba indigo shadow → sage 18px halo
   - User-custom badges: indigo tokens → amber (user content = warm user
     contribution, different character from the "state/primary" sage)
   - AI-gen button: `background: var(--color-primary); color: white` on hover
     violation → sage fill with sage-100 text + glow (no #fff/white)
   - Custom-add button: raw rgba indigo → amber dashed warm invitation */

.step-select-one {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.step-title {
  font-family: var(--font-serif-cjk);
  font-size: 1.2rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-text);
}

/* ── Two-column layout ── */

.step-layout {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 1.125rem;
  align-items: start;
}

.preset-list {
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.detail-col {
  position: sticky;
  top: 0;
}

@media (max-width: 640px) {
  .step-layout { grid-template-columns: 1fr; }
  .detail-col { display: none; }
}

.preset-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  text-align: left;
  color: var(--color-text);
  transition: border-color var(--duration-fast) var(--ease-out),
              background-color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}

.preset-card:hover:not(.disabled) {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: linear-gradient(180deg, color-mix(in oklch, var(--color-sage-400) 7%, var(--color-surface-elevated)), color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-elevated)));
}

.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.budget-badge {
  flex: none;
  color: var(--color-text-secondary);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.preset-card.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.preset-card.selected {
  border-color: color-mix(in oklch, var(--color-sage-400) 60%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 12%, var(--color-surface-elevated));
  box-shadow: 0 0 18px color-mix(in oklch, var(--color-sage-400) 20%, transparent),
              inset 0 0 12px color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.preset-name {
  font-family: var(--font-serif-cjk);
  font-weight: 500;
  font-size: 0.94rem;
  letter-spacing: 0.04em;
  color: var(--color-text);
}

.preset-desc {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  letter-spacing: 0.01em;
  color: var(--color-text-umber);
  line-height: 1.7;
}

.preset-cost {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  color: var(--color-amber-300);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in oklch, var(--color-amber-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-amber-400) 25%, transparent);
  align-self: flex-start;
  margin-top: 0.125rem;
}

/* AI-gen button — sage with soft glow. Replaces old indigo hover that
   set `color: white`. */
.ai-section {
  display: flex;
  justify-content: center;
  padding-top: 0.375rem;
}

.btn-ai {
  padding: 0.6rem 1.25rem;
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  border-radius: var(--radius-md);
  color: var(--color-sage-300);
  font-family: var(--font-sans);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out),
              box-shadow var(--duration-fast) var(--ease-out);
}
.btn-ai:hover {
  background: color-mix(in oklch, var(--color-sage-400) 18%, transparent);
  border-color: var(--color-sage-400);
  color: var(--color-sage-100);
  box-shadow: 0 0 16px color-mix(in oklch, var(--color-sage-400) 30%, transparent),
              0 0 24px color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}

/* ── User-custom entry UI — amber palette (user warmth) ── */

.custom-add-btn {
  padding: 0.625rem 0.875rem;
  background: color-mix(in oklch, var(--color-amber-400) 6%, transparent);
  border: 1px dashed color-mix(in oklch, var(--color-amber-400) 40%, transparent);
  border-radius: var(--radius-lg);
  color: var(--color-amber-300);
  font-family: var(--font-sans);
  font-size: 0.82rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  cursor: pointer;
  text-align: center;
  transition: background var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              color var(--duration-fast) var(--ease-out);
}
.custom-add-btn:hover {
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
  border-color: var(--color-amber-400);
  border-style: solid;
  color: var(--color-amber-100);
}

.preset-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.preset-card--user {
  border-color: color-mix(in oklch, var(--color-amber-400) 30%, var(--color-border));
}

.user-badge-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.user-badge {
  display: inline-flex;
  padding: 1px 8px;
  font-family: var(--font-sans);
  font-size: 0.62rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-amber-300);
  background: color-mix(in oklch, var(--color-amber-400) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-amber-400) 30%, transparent);
  border-radius: var(--radius-sm);
}

.user-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 0.78rem;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out),
              border-color var(--duration-fast) var(--ease-out),
              background var(--duration-fast) var(--ease-out);
}
.user-action:hover {
  color: var(--color-sage-300);
  border-color: color-mix(in oklch, var(--color-sage-400) 40%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 5%, transparent);
}
.user-action--del:hover {
  color: color-mix(in oklch, var(--color-danger) 95%, var(--color-text));
  border-color: color-mix(in oklch, var(--color-danger) 45%, transparent);
  background: color-mix(in oklch, var(--color-danger) 8%, transparent);
}
</style>
