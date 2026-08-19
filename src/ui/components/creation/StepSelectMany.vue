<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.3
/**
 * StepSelectMany — 创角步骤：多选。
 *
 * 允许用户从预设列表中选择多个条目。
 * 支持花费追踪：若 step.costField 存在，每个条目有花费值，
 * 选中时从 budget 扣除，超出预算的条目不可选。
 * 已选条目右上角显示勾选标记。
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
  step: CreationStep;
  presets: unknown[];
  /** 当前选中值 — 多选时为数组 */
  selection: unknown;
  budget: number;
  budgetSummary?: BudgetSummary | null;
}>();

const emit = defineEmits<{
  select: [value: unknown];
  customSave: [payload: {
    fields: Record<string, unknown>;
    editingId: string | null;
    generatedBy: 'manual' | 'ai';
  }];
  customRemove: [id: string];
}>();

// ─── 2026-04-14：自定义预设 modal 状态 ──────────────────────

const customModalOpen = ref(false);
const editingId = ref<string | null>(null);
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
  ev.stopPropagation();
  if (preset.source !== 'user' || typeof preset.id !== 'string') return;
  if (!window.confirm(t('creation.selectMany.confirmDelete', { name: getDisplayName(preset) }))) return;
  emit('customRemove', preset.id);
}

function handleEdit(preset: PresetEntry, ev: Event): void {
  ev.stopPropagation();
  openEditModal(preset);
}

// ─── 2026-04-14 Phase 3：AI 推演 ──────────────────────────

const aiGenModalOpen = ref(false);
const aiSourceFlag = ref(false);

const aiEnabled = computed(() => props.step.aiGeneration?.enabled === true);

function openAIGenModal(): void {
  aiGenModalOpen.value = true;
}

function handleAIGenerated(fields: Record<string, unknown>): void {
  editingId.value = null;
  editingInitial.value = fields;
  aiSourceFlag.value = true;
  customModalOpen.value = true;
}

/** 安全转换预设数据 */
const typedPresets = computed<PresetEntry[]>(() =>
  props.presets.map((p) => {
    if (typeof p === 'object' && p !== null) return p as PresetEntry;
    return { name: String(p) } as PresetEntry;
  }),
);

/** 当前选中列表 */
const selectedList = computed<PresetEntry[]>(() => {
  if (!Array.isArray(props.selection)) return [];
  return props.selection as PresetEntry[];
});

/** 获取条目花费 */
function getCost(preset: PresetEntry): number | null {
  if (!props.step.costField) return null;
  const raw = preset[props.step.costField];
  return typeof raw === 'number' ? raw : null;
}

/** 条目唯一标识 */
function getKey(preset: PresetEntry): string {
  return String(preset.id ?? preset.name ?? '');
}

/** 是否已选中 */
function isSelected(preset: PresetEntry): boolean {
  const key = getKey(preset);
  return selectedList.value.some((s) => getKey(s) === key);
}

/** 是否因预算不足而禁用（未选中状态下检查） */
function isDisabled(preset: PresetEntry): boolean {
  return !canAffordPresetCandidate(
    props.step,
    preset,
    props.selection,
    props.budgetSummary ?? null,
  );
}

/**
 * 切换选中状态
 *
 * 2026-04-11 fix：只 emit 被点击的那个 preset，让 `useCreationFlow.toggleMany`
 * 在 composable 层面完成 add/remove 语义。
 *
 * 之前版本在本地计算 `next` 数组再 emit — 而 `CreationView.onStepSelect` 的
 * select-many 分支把收到的数组当成**单个 item** 传给 `toggleMany(stepId, item)`，
 * 造成：
 *   1. 数组被塞成嵌套层级 `[[preset]]` → `[[preset], [[preset]]]` → ...
 *   2. `isSelected` 按 id/name 对比永远不匹配 → 卡片从不高亮
 *   3. 重复点同一选项不会撤销，只是不断往外包一层
 *
 * 单源真相原则：toggle 语义只存一份（`toggleMany` in composable），UI 只负责
 * 事件转发。这也和 StepSelectOne 的 `selectPreset` 保持一致 —— 后者也只 emit
 * 被点的 preset，不做本地状态计算。
 */
function toggle(preset: PresetEntry): void {
  if (isDisabled(preset)) return;
  emit('select', preset);
}

/** 显示名称 */
function getDisplayName(preset: PresetEntry): string {
  return preset.name ?? preset.label ?? String(preset.id ?? t('creation.selectMany.unnamed'));
}

/** 当前悬停的预设条目（用于右侧详情面板） */
const hoveredPreset = ref<PresetEntry | null>(null);
</script>

<template>
  <div class="step-select-many">
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
        <!-- "+ 自定义" 按钮（仅当 step 配置了 customSchema 时） -->
        <button
          v-if="hasCustomSchema"
          type="button"
          class="custom-add-btn"
          @click="openAddModal"
        >
          {{ $t('creation.selectMany.addCustom', { label: step.label }) }}
        </button>

        <button
          v-for="(preset, idx) in typedPresets"
          :key="getKey(preset) || idx"
          class="preset-card"
          :class="{
            selected: isSelected(preset),
            disabled: isDisabled(preset),
            'preset-card--user': preset.source === 'user',
          }"
          :disabled="isDisabled(preset)"
          @click="toggle(preset)"
          @mouseenter="hoveredPreset = preset"
          @mouseleave="hoveredPreset = null"
        >
          <!-- 选中标记 -->
          <span v-if="isSelected(preset)" class="check-mark">✓</span>

          <div class="preset-card-header">
            <span class="preset-name">{{ getDisplayName(preset) }}</span>
            <div v-if="preset.source === 'user'" class="user-badge-row">
              <Tooltip :text="$t('creation.selectMany.userCustomTooltip')">
                <span class="user-badge">{{ $t('creation.selectMany.customizeStep', { label: '' }) }}</span>
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
            {{ $t('creation.selectMany.cost', { value: getCost(preset) }) }}
          </span>
        </button>

        <!-- AI 生成按钮 —— 仅 step 配置 customSchema + aiGeneration.enabled 时显示 -->
        <div v-if="aiEnabled && hasCustomSchema" class="ai-section">
          <button class="btn-ai" type="button" @click="openAIGenModal">
            {{ $t('creation.selectMany.aiGenButton') }}
          </button>
        </div>
      </div>

      <!-- 右栏：选项详情面板 -->
      <div class="detail-col">
        <PresetDetailPanel
          :item="hoveredPreset"
          :fields="step.detailFields"
          :cost-field="step.costField"
        />
      </div>
    </div>

    <CustomPresetModal
      v-if="step.customSchema"
      v-model="customModalOpen"
      :title="
        editingId
          ? t('creation.selectMany.editCustom', { label: step.label })
          : aiSourceFlag
          ? t('creation.selectMany.reviewAIGenerated', { label: step.label })
          : t('creation.selectMany.customizeStep', { label: step.label })
      "
      :schema="step.customSchema"
      :initial-data="editingInitial"
      @submit="handleCustomSubmit"
    />

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
   - Shares most idioms with StepSelectOne; this file additionally has:
     • budget-badge (count of remaining points) — retokenized
     • check-mark on selected card — was `var(--color-success) + color: white`,
       now sage-400 + bg-color glyph with halo
     • disabled state for over-budget cards
     • HARDCODED INDIGO→VIOLET GRADIENT on AI button REMOVED per brief
       "no neon ring halos" + sage/amber-only palette rule */

.step-select-many {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.step-title {
  font-family: var(--font-serif-cjk);
  font-size: 1.2rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-text);
}

.budget-badge {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  padding: 0.375rem 0.875rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
}

.budget-badge strong {
  color: var(--color-sage-300);
  font-weight: 600;
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
              box-shadow var(--duration-fast) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
}

.preset-card:hover:not(.disabled) {
  border-color: color-mix(in oklch, var(--color-sage-400) 45%, transparent);
  background: linear-gradient(180deg, color-mix(in oklch, var(--color-sage-400) 7%, var(--color-surface-elevated)), color-mix(in oklch, var(--color-sage-400) 3%, var(--color-surface-elevated)));
}

.preset-card.selected {
  border-color: color-mix(in oklch, var(--color-sage-400) 60%, transparent);
  background: color-mix(in oklch, var(--color-sage-400) 12%, var(--color-surface-elevated));
  box-shadow: 0 0 18px color-mix(in oklch, var(--color-sage-400) 20%, transparent),
              inset 0 0 12px color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.preset-card.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.check-mark {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-sage-400);
  color: var(--color-bg);
  border-radius: 50%;
  font-size: 0.72rem;
  font-weight: 700;
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400) 45%, transparent),
              inset 0 1px 2px rgba(255, 255, 255, 0.2);
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.3);
}

.preset-name {
  font-family: var(--font-serif-cjk);
  font-weight: 500;
  font-size: 0.94rem;
  letter-spacing: 0.04em;
  color: var(--color-text);
  padding-right: 1.75rem;
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

/* ── User-custom entry UI (amber) ── */

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

/* ── AI section — sanctuary sage, never indigo→violet gradient ── */
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
</style>
