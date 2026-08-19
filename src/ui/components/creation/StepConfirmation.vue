<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.6
/**
 * StepConfirmation — 创角步骤：最终确认。
 *
 * 接收父组件传入的所有先前步骤选择（通过 selection prop），
 * 以摘要卡片形式展示角色预览信息（名称、特征、属性等），
 * 并提供 "开始游戏" 按钮。
 */
import { computed, ref, inject, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CreationStep } from '@/engine/types';
import type { ConfigResolver } from '@/engine/core/config-system';
import type { GamePack } from '@/engine/types/game-pack';
import { DEFAULT_ENGINE_PATHS } from '@/engine/pipeline/types';
import AgaSelect from '@/ui/components/shared/AgaSelect.vue';
import type { SelectOption } from '@/ui/components/shared/AgaSelect.vue';
import AgaToggle from '@/ui/components/shared/AgaToggle.vue';
import type { BudgetSummary } from '@/engine/creation/creation-budget';

const { t } = useI18n();

const configResolver = inject<ConfigResolver>('configResolver')!;
const gamePack = inject<GamePack>('gamePack')!;

const ENHANCED_OPENING_DOMAIN = 'enhancedOpening';

const ENHANCED_OPENING_DEFAULTS: Record<string, unknown> = {
  enabled: true,
  npcRange: [5, 15],
  locationRange: [10, 20],
  edgeRange: [5, 15],
  inventoryRange: [3, 8],
  relationDensity: 'medium',
  bypassRateLimitDuringOpening: false,
};

/** 单条摘要 — 步骤 ID + 显示标签 + 选择内容 */
interface SummaryItem {
  stepId: string;
  label: string;
  display: string;
}

const props = defineProps<{
  step: CreationStep;
  presets: unknown[];
  /**
   * 所有步骤的选择结果汇总 — 父组件传入
   * 结构: Record<stepId, { label, value }>
   */
  selection: unknown;
  budget: number;
  budgetSummary?: BudgetSummary | null;
}>();

const emit = defineEmits<{
  select: [value: unknown];
}>();

/** 将 selection 解析为 SummaryItem[] */
const summaryItems = computed<SummaryItem[]>(() => {
  if (typeof props.selection !== 'object' || props.selection === null) return [];

  const entries = Object.entries(props.selection as Record<string, unknown>);
  return entries.map(([stepId, raw]) => {
    const item = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const label = typeof item.label === 'string' ? item.label : stepId;
    const value = item.value ?? raw;
    return {
      stepId,
      label,
      display: formatValue(value),
    };
  });
});

/**
 * 将任意选择值格式化为显示文本。
 * 对象取 name/label，数组逗号拼接，其余直接 String()。
 */
function formatValue(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (Array.isArray(val)) {
    return val.map((v) => formatValue(v)).join(t('creation.confirm.separator')) || '—';
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.name === 'string') return obj.name;
    if (typeof obj.label === 'string') return obj.label;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '—';
    return keys
      .map((k) => `${k}: ${formatValue(obj[k])}`)
      .join(t('creation.confirm.separator'));
  }
  return String(val);
}

/** 从单步 value（表单键、预设条目等）解析显示用姓名 */
function extractCharacterNameFromValue(val: unknown): string | null {
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return null;
  const o = val as Record<string, unknown>;
  const keys = [
    DEFAULT_ENGINE_PATHS.playerName,
    '名字',
    'name',
    '角色名',
    'characterName',
  ];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  if (typeof o.name === 'string' && o.name.trim()) return o.name.trim();
  return null;
}

/**
 * 提取角色名称 — 兼容：
 * - 父组件传入的汇总：`{ stepId: { label, value } }`
 * - 预设单选：`value` 为带 `name`/`label` 的对象
 * - 表单：`value` 为含 `角色.基础信息.姓名` 等键的平铺对象
 */
const characterName = computed<string>(() => {
  if (typeof props.selection !== 'object' || props.selection === null) return t('creation.confirm.unnamedCharacter');
  const sel = props.selection as Record<string, unknown>;
  for (const entry of Object.values(sel)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const raw = obj.value !== undefined ? obj.value : obj;
    const name = extractCharacterNameFromValue(raw);
    if (name) return name;
  }
  return t('creation.confirm.unnamedCharacter');
});

// ─── 开局选项 ────────────────────────────────────────────────

/** 是否开启流式叙事（逐字输出 vs 一次性显示） */
const streamingEnabled = ref(true);

/** 生成模式：分步（step）或一次性（single） */
const generationMode = ref<'step' | 'single'>('single');

/** 增强开局（Story 0）：默认开启 */
const enhancedOpening = ref(true);

/** 高级设置展开状态 */
const advancedExpanded = ref(false);

/** 高级设置值 */
const npcRange = ref<[number, number]>([5, 15]);
const locationRange = ref<[number, number]>([10, 20]);
const edgeRange = ref<[number, number]>([5, 15]);
const inventoryRange = ref<[number, number]>([3, 8]);
const relationDensity = ref<'sparse' | 'medium' | 'dense'>('medium');
const bypassRateLimit = ref(false);

/**
 * §4.1c: toggle 改变时立即 emit，让 CreationView 持续同步 generationMode
 *
 * 之前这个 toggle 只在用户点内部"开始游戏"按钮时才 emit，但用户也可能点
 * CreationView 底栏的"开始游戏"按钮（那个直接调 onFinalize），该路径不会
 * 触发任何 emit → toggle 状态从未同步 → 分步开局永远是 'single'。
 *
 * 解决方案：每次 toggle 变化都主动 emit，CreationView 的 onStepSelect
 * confirmation 分支会持续捕获最新值到 `splitGenOpening` ref。
 */
function clampRange(range: [number, number], min: number, max: number): [number, number] {
  let [lo, hi] = range;
  lo = Math.max(min, Math.min(max, Math.round(lo) || min));
  hi = Math.max(min, Math.min(max, Math.round(hi) || min));
  if (lo > hi) [lo, hi] = [hi, lo];
  return [lo, hi];
}

function emitCurrentOptions(): void {
  const clampedNpc = clampRange(npcRange.value, 3, 30);
  const clampedLoc = clampRange(locationRange.value, 5, 40);
  const clampedEdge = clampRange(edgeRange.value, 3, 30);
  const clampedInv = clampRange(inventoryRange.value, 1, 15);

  npcRange.value = clampedNpc;
  locationRange.value = clampedLoc;
  edgeRange.value = clampedEdge;
  inventoryRange.value = clampedInv;

  saveSettings();

  emit('select', {
    __confirm: false,
    options: {
      streaming: streamingEnabled.value,
      generationMode: generationMode.value,
      enhancedOpening: enhancedOpening.value,
      enhancedOpeningSettings: {
        enabled: enhancedOpening.value,
        npcRange: clampedNpc,
        locationRange: clampedLoc,
        edgeRange: clampedEdge,
        inventoryRange: clampedInv,
        relationDensity: relationDensity.value,
        bypassRateLimitDuringOpening: bypassRateLimit.value,
      },
    },
  });
}

const densityOptions = computed<SelectOption[]>(() => [
  { label: t('creation.confirm.options.densitySparse'), value: 'sparse' },
  { label: t('creation.confirm.options.densityMedium'), value: 'medium' },
  { label: t('creation.confirm.options.densityDense'), value: 'dense' },
]);

function onDensityChange(val: string): void {
  relationDensity.value = val as 'sparse' | 'medium' | 'dense';
  emitCurrentOptions();
}

function toggleEnhancedOpening(): void {
  enhancedOpening.value = !enhancedOpening.value;
  emitCurrentOptions();
}

function toggleStreaming(): void {
  streamingEnabled.value = !streamingEnabled.value;
  emitCurrentOptions();
}

function toggleGenerationMode(): void {
  generationMode.value = generationMode.value === 'step' ? 'single' : 'step';
  emitCurrentOptions();
}

function saveSettings(): void {
  const packId = gamePack.manifest.id;
  const patches: Record<string, unknown> = {
    enabled: enhancedOpening.value,
    npcRange: npcRange.value,
    locationRange: locationRange.value,
    edgeRange: edgeRange.value,
    inventoryRange: inventoryRange.value,
    relationDensity: relationDensity.value,
    bypassRateLimitDuringOpening: bypassRateLimit.value,
  };
  configResolver.saveUserPatch(packId, ENHANCED_OPENING_DOMAIN, patches).catch(() => {});
}

async function loadSettings(): Promise<void> {
  try {
    const packId = gamePack.manifest.id;
    const resolved = await configResolver.resolve(packId, ENHANCED_OPENING_DOMAIN, ENHANCED_OPENING_DEFAULTS);
    if (!resolved.isModified) return;
    const saved = resolved.data;
    const isNumPair = (v: unknown): v is [number, number] =>
      Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
    if (typeof saved.enabled === 'boolean') enhancedOpening.value = saved.enabled;
    if (isNumPair(saved.npcRange)) npcRange.value = saved.npcRange;
    if (isNumPair(saved.locationRange)) locationRange.value = saved.locationRange;
    if (isNumPair(saved.edgeRange)) edgeRange.value = saved.edgeRange;
    if (isNumPair(saved.inventoryRange)) inventoryRange.value = saved.inventoryRange;
    if (saved.relationDensity === 'sparse' || saved.relationDensity === 'medium' || saved.relationDensity === 'dense') {
      relationDensity.value = saved.relationDensity as 'sparse' | 'medium' | 'dense';
    }
    if (typeof saved.bypassRateLimitDuringOpening === 'boolean') bypassRateLimit.value = saved.bypassRateLimitDuringOpening;
    emitCurrentOptions();
  } catch { /* IndexedDB unavailable — start with defaults */ }
}

onMounted(() => {
  loadSettings();
});

// 2026-04-11：移除了内部 "开始游戏" 按钮 —— 原本这里有一个冗余的 `startGame()`
// 触发 `__confirm: true` emit，但 CreationView 底栏已经有唯一的 "开始游戏" 按钮
// 直接调用 onFinalize()，两个入口视觉上重复而且容易让玩家困惑。
// 现在 StepConfirmation 只负责展示摘要 + 选项 toggle，"开始游戏" 由底栏统一处理。
// CreationView.onStepSelect 的 `__confirm: true` 分支保留（死分支），不会被触发
// 但也不会出错。
</script>

<template>
  <div class="step-confirmation">
    <h3 class="step-title">{{ step.label }}</h3>

    <!-- 角色预览卡 -->
    <div class="character-preview">
      <div class="avatar-placeholder">{{ characterName.charAt(0) }}</div>
      <h4 class="character-name">{{ characterName }}</h4>
    </div>

    <!-- 摘要列表 -->
    <div class="summary-list">
      <div v-if="budgetSummary" class="summary-row summary-row--budget" data-testid="creation-budget-summary">
        <span class="summary-label">{{ $t('creation.confirm.budget') }}</span>
        <span class="summary-value">
          {{ $t('creation.confirm.budgetValue', {
            spent: budgetSummary.spent,
            total: budgetSummary.total,
            remaining: budgetSummary.remaining,
          }) }}
        </span>
      </div>
      <div v-for="item in summaryItems" :key="item.stepId" class="summary-row">
        <span class="summary-label">{{ item.label }}</span>
        <span class="summary-value">{{ item.display }}</span>
      </div>

      <div v-if="summaryItems.length === 0" class="summary-empty">
        {{ $t('creation.confirm.noData') }}
      </div>
    </div>

    <!-- 开局选项 -->
    <div class="options-section">
      <h4 class="options-title">{{ $t('creation.confirm.options.title') }}</h4>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">{{ $t('creation.confirm.options.streaming') }}</span>
          <span class="toggle-desc">{{ $t('creation.confirm.options.streamingDesc') }}</span>
        </div>
        <AgaToggle
          :model-value="streamingEnabled"
          :label="$t('creation.confirm.options.streamingToggle')"
          @update:model-value="() => toggleStreaming()"
        />
      </div>

      <div v-if="!enhancedOpening" class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">{{ $t('creation.confirm.options.stepGen') }}</span>
          <span class="toggle-desc">{{ $t('creation.confirm.options.stepGenDesc') }}</span>
        </div>
        <AgaToggle
          :model-value="generationMode === 'step'"
          :label="$t('creation.confirm.options.stepGenToggle')"
          @update:model-value="() => toggleGenerationMode()"
        />
      </div>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">{{ $t('creation.confirm.options.enhancedOpening') }}</span>
          <span class="toggle-desc">{{ $t('creation.confirm.options.enhancedOpeningDesc') }}</span>
        </div>
        <AgaToggle
          data-testid="creation-enhanced-toggle"
          :model-value="enhancedOpening"
          :label="$t('creation.confirm.options.enhancedOpeningToggle')"
          @update:model-value="() => toggleEnhancedOpening()"
        />
      </div>

      <!-- Advanced settings (collapsible, only when enhanced opening is on) -->
      <div v-if="enhancedOpening" class="advanced-section">
        <button class="advanced-toggle" @click="advancedExpanded = !advancedExpanded">
          {{ $t('creation.confirm.options.advancedSettings') }}
          <span class="advanced-chevron" :class="{ expanded: advancedExpanded }">&#9662;</span>
        </button>

        <div v-if="advancedExpanded" class="advanced-fields">
          <div class="range-row">
            <span class="range-label">{{ $t('creation.confirm.options.npcRange') }}</span>
            <input v-model.number="npcRange[0]" type="number" min="3" max="20" class="range-input" @change="emitCurrentOptions">
            <span class="range-sep">-</span>
            <input v-model.number="npcRange[1]" type="number" min="5" max="30" class="range-input" @change="emitCurrentOptions">
          </div>
          <div class="range-row">
            <span class="range-label">{{ $t('creation.confirm.options.locationRange') }}</span>
            <input v-model.number="locationRange[0]" type="number" min="5" max="30" class="range-input" @change="emitCurrentOptions">
            <span class="range-sep">-</span>
            <input v-model.number="locationRange[1]" type="number" min="8" max="40" class="range-input" @change="emitCurrentOptions">
          </div>
          <div class="range-row">
            <span class="range-label">{{ $t('creation.confirm.options.edgeRange') }}</span>
            <input v-model.number="edgeRange[0]" type="number" min="3" max="20" class="range-input" @change="emitCurrentOptions">
            <span class="range-sep">-</span>
            <input v-model.number="edgeRange[1]" type="number" min="5" max="30" class="range-input" @change="emitCurrentOptions">
          </div>
          <div class="range-row">
            <span class="range-label">{{ $t('creation.confirm.options.inventoryRange') }}</span>
            <input v-model.number="inventoryRange[0]" type="number" min="1" max="10" class="range-input" @change="emitCurrentOptions">
            <span class="range-sep">-</span>
            <input v-model.number="inventoryRange[1]" type="number" min="3" max="15" class="range-input" @change="emitCurrentOptions">
          </div>

          <div class="range-row density-row">
            <span class="range-label">{{ $t('creation.confirm.options.relationDensity') }}</span>
            <AgaSelect
              :model-value="relationDensity"
              :options="densityOptions"
              @update:model-value="onDensityChange"
            />
          </div>

          <div class="toggle-row compact">
            <div class="toggle-info">
              <span class="toggle-label small">{{ $t('creation.confirm.options.bypassRateLimit') }}</span>
              <span class="toggle-desc">{{ $t('creation.confirm.options.bypassRateLimitWarning') }}</span>
            </div>
            <AgaToggle
              :model-value="bypassRateLimit"
              :label="$t('creation.confirm.options.bypassRateLimit')"
              @update:model-value="v => { bypassRateLimit = v; emitCurrentOptions(); }"
            />
          </div>
        </div>
      </div>
    </div>

    <!--
      2026-04-11 fix：移除了 StepConfirmation 内部的冗余 "开始游戏" 按钮。
      底栏（CreationView.footer）已经有一个 "开始游戏" 按钮直接调用 onFinalize()，
      两处重复按钮视觉上误导玩家。现在只保留底栏那个。
    -->
  </div>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21:
   - avatar-placeholder `#fff` on sage fill → sage tinted surface + sage-100
     font + sage border (matches ManagementView avatar language)
   - toggle-thumb `background: white` → `--color-text-bone` warm bone
   - toggle-switch active: raw primary → sage mix + halo (matches AgaToggle)
   - character-name / labels: serif + sanctuary letter-spacing
   - Cards migrated from raw bg to surface-elevated */

.step-confirmation {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  max-width: 560px;
  margin: 0 auto;
}

.step-title {
  font-family: var(--font-serif-cjk);
  font-size: 1.2rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-text);
  align-self: flex-start;
}

.character-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.875rem;
  padding: 1.625rem 2rem;
  background: color-mix(in oklch, var(--color-surface) 75%, transparent);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  width: 100%;
  box-shadow: inset 0 1px 0 color-mix(in oklch, var(--color-text) 4%, transparent),
              inset 0 0 12px color-mix(in oklch, var(--color-sage-400) 4%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.avatar-placeholder {
  width: 68px;
  height: 68px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklch, var(--color-sage-400) 14%, var(--color-surface-elevated));
  color: var(--color-sage-100);
  font-family: var(--font-serif-cjk);
  font-size: 1.7rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
  border-radius: 50%;
  box-shadow: 0 0 16px color-mix(in oklch, var(--color-sage-400) 15%, transparent),
              inset 0 0 16px color-mix(in oklch, var(--color-sage-400) 8%, transparent);
}

.character-name {
  font-family: var(--font-serif-cjk);
  font-size: 1.25rem;
  font-weight: 500;
  letter-spacing: 0.1em;
  color: var(--color-text);
}

.summary-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.summary-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0.625rem 0.875rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  gap: 1rem;
}

.summary-label {
  font-family: var(--font-sans);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  text-transform: uppercase;
  flex-shrink: 0;
}

.summary-value {
  font-family: var(--font-serif-cjk);
  font-size: 0.86rem;
  letter-spacing: 0.02em;
  color: var(--color-text);
  text-align: right;
  word-break: break-word;
}

.summary-empty {
  text-align: center;
  padding: 1.5rem;
  color: var(--color-text-muted);
  font-family: var(--font-serif-cjk);
  font-style: italic;
  font-size: 0.86rem;
}

/* ── Options section ── */

.options-section {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.options-title {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text-umber);
  letter-spacing: 0.12em;
  margin-bottom: 0.25rem;
  padding-left: 4px;
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.875rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  cursor: pointer;
  gap: 1rem;
  transition: border-color var(--duration-fast) var(--ease-out);
}
.toggle-row:hover {
  border-color: color-mix(in oklch, var(--color-sage-400) 30%, var(--color-border));
}

.toggle-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
}

.toggle-label {
  font-family: var(--font-serif-cjk);
  font-size: 0.88rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text);
}

.toggle-desc {
  font-family: var(--font-serif-cjk);
  font-size: 0.74rem;
  color: var(--color-text-umber);
  font-style: italic;
  line-height: 1.6;
  letter-spacing: 0.01em;
}

/* ── Advanced settings ── */
.advanced-section {
  margin-top: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border-subtle);
}

.advanced-toggle {
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-family: var(--font-serif-cjk);
  font-size: 0.78rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  padding: 0.25rem 0;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  transition: color var(--duration-fast) var(--ease-out);
}

.advanced-toggle:hover {
  color: var(--color-text);
}

.advanced-chevron {
  font-size: 0.65rem;
  transition: transform var(--duration-fast) var(--ease-out);
}

.advanced-chevron.expanded {
  transform: rotate(180deg);
}

.advanced-fields {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.625rem;
}

.range-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.875rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
}

.range-label {
  flex: 1;
  font-family: var(--font-serif-cjk);
  font-size: 0.8rem;
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
}

.range-input {
  width: 52px;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: 0.8rem;
  text-align: center;
  transition: border-color var(--duration-fast) var(--ease-out);
}

.range-input:focus {
  outline: none;
  border-color: var(--color-sage-400);
}

.range-sep {
  color: var(--color-text-muted);
  font-size: 0.8rem;
}

.density-row :deep(.aga-select) {
  min-width: 100px;
}

.toggle-row.compact {
  padding: 0.5rem 0.875rem;
}

.toggle-label.small {
  font-size: 0.8rem;
}
</style>
