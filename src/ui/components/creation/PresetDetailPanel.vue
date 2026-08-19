<script setup lang="ts">
// App doc: docs/user-guide/pages/creation.md §2.9
/**
 * PresetDetailPanel — 显示预设条目的完整详情。
 *
 * 用于 StepSelectOne / StepSelectMany 的右侧详情栏：
 * 当用户 hover 或选中一个选项时，该面板展示其完整描述、
 * 属性修正、效果列表、稀有度等信息。
 *
 * 设计原则：
 * - 无 item 时显示空态引导
 * - 无 detailFields 时回退到仅显示 description（向后兼容）
 * - 稀有度 (rarity) 始终渲染为彩色徽章（若字段存在）
 */
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DetailField, PresetEntry } from '@/engine/types';

const props = defineProps<{
  /** 当前悬停或选中的预设条目，null 时显示空态 */
  item: PresetEntry | null;
  /** 详情字段定义（来自 step.detailFields）；缺省时退化为显示 description */
  fields?: DetailField[];
  /** 花费字段名（来自 step.costField），用于显示点数消耗 */
  costField?: string;
}>();

const { t } = useI18n();

const HIDDEN_KEYS = new Set(['id', 'name', 'label', 'description', 'rarity']);

/** 展示名称 */
function getDisplayName(entry: PresetEntry): string {
  return entry.name ?? entry.label ?? String(entry.id ?? t('creation.selectOne.unnamed'));
}

/** 花费值 */
const costDisplay = computed<number | null>(() => {
  if (!props.costField || !props.item) return null;
  const v = props.item[props.costField];
  return typeof v === 'number' ? v : null;
});

/** 额外键值对：排除已在其他区域展示的基础字段 */
const extraFields = computed<Record<string, unknown>>(() => {
  if (!props.item) return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props.item)) {
    if (HIDDEN_KEYS.has(k)) continue;
    if (props.costField && k === props.costField) continue;
    if (v === undefined || v === null) continue;
    result[k] = v;
  }
  return result;
});

/** 将 DetailField 的值渲染为字符串 */
function renderField(f: DetailField): string {
  if (!props.item) return '—';
  const val = props.item[f.key];
  if (f.formatter) return f.formatter(val);
  return formatVal(val);
}

/** 通用值格式化 */
function formatVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) {
    return (
      v
        .map((x) =>
          typeof x === 'object' && x !== null
            ? ((x as Record<string, unknown>).name ??
               (x as Record<string, unknown>).label ??
               JSON.stringify(x))
            : String(x),
        )
        .join(t('creation.confirm.separator')) || '—'
    );
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.map(([k, val]) => `${k}: ${val}`).join('  ') || '—';
  }
  return String(v);
}
</script>

<template>
  <div class="detail-panel">
    <!-- 空态 -->
    <div v-if="!item" class="detail-empty">
      <span class="detail-empty-icon" aria-hidden="true">◈</span>
      <p>{{ $t('creation.presetDetail.empty') }}</p>
    </div>

    <template v-else>
      <!-- 标题 + 稀有度 -->
      <div class="detail-header">
        <h4 class="detail-name">{{ getDisplayName(item) }}</h4>
        <span
          v-if="item.rarity"
          class="rarity-badge"
          :class="`rarity--${item.rarity}`"
        >
          {{ $t('creation.presetDetail.rarity.' + item.rarity) }}
        </span>
      </div>

      <!-- 花费 -->
      <div v-if="costDisplay !== null" class="detail-cost">
        {{ $t('creation.presetDetail.cost', { value: costDisplay }) }}
      </div>

      <!-- 自定义字段列表（若 detailFields 已配置） -->
      <template v-if="fields && fields.length > 0">
        <div
          v-for="f in fields"
          :key="f.key"
          class="detail-field"
        >
          <span class="detail-field-label">{{ f.label }}</span>
          <span class="detail-field-value">{{ renderField(f) }}</span>
        </div>
      </template>

      <!-- 回退：显示完整 description + 额外键值对 -->
      <template v-else>
        <p v-if="item.description" class="detail-description">
          {{ item.description }}
        </p>
        <p v-else class="detail-no-desc">{{ $t('creation.presetDetail.noDesc') }}</p>

        <div
          v-for="(val, key) in extraFields"
          :key="key"
          class="detail-field"
        >
          <span class="detail-field-label">{{ key }}</span>
          <span class="detail-field-value">{{ formatVal(val) }}</span>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
/* Sanctuary migration 2026-04-21 — ABSOLUTE-BAN FIX + rarity retoken:
   - `.detail-field { border-left: 2px solid var(--color-border) }` REMOVED
     per brief "never colored side-stripes (absolute ban)". Replaced with
     a left-padded `::before` 4px sage dot — list-marker glyph, not stripe.
   - Rarity badges: 5 Tailwind hex (`#9ca3af`/`#60a5fa`/`#4ade80`/`#c084fc`/
     `#fbbf24`) collapsed into sanctuary sage+amber only:
       普通 → text-muted
       稀有 → sage-300
       精良 → sage-400 + halo
       史诗 → amber-300
       传说 → amber-400 + halo
   - Empty state: sage dim glyph + serif italic text
   - Description: serif body for narrative prose
   - Local scrollbar override removed (global sanctuary scrollbar applies) */

.detail-panel {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
  padding: 1.125rem;
  background: color-mix(in oklch, var(--color-surface) 80%, transparent);
  border: none;
  border-radius: var(--radius-lg);
  min-height: 220px;
  height: 100%;
  overflow-y: auto;
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

/* ── Empty state ── */

.detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  color: var(--color-text-muted);
  opacity: 0.75;
  text-align: center;
  padding: 2rem 0.75rem;
}

.detail-empty-icon {
  font-family: var(--font-serif-cjk);
  font-size: 2rem;
  line-height: 1;
  color: var(--color-sage-600);
}

.detail-empty p {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  font-style: italic;
  letter-spacing: 0.04em;
  line-height: 1.6;
}

/* ── Header ── */

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.625rem;
}

.detail-name {
  font-family: var(--font-serif-cjk);
  font-size: 1.05rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--color-text);
  line-height: 1.3;
}

/* ── Rarity badge — sage + amber only ── */

.rarity-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: var(--radius-full);
  font-family: var(--font-sans);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  flex-shrink: 0;
  border: 1px solid currentColor;
}

.rarity--普通  { color: var(--color-text-muted); }
.rarity--稀有  { color: var(--color-sage-300); }
.rarity--精良  {
  color: var(--color-sage-400);
  box-shadow: 0 0 8px color-mix(in oklch, var(--color-sage-400) 25%, transparent);
}
.rarity--史诗  { color: var(--color-amber-300); }
.rarity--传说  {
  color: var(--color-amber-400);
  box-shadow: 0 0 10px color-mix(in oklch, var(--color-amber-400) 30%, transparent);
}

/* ── Cost ── */

.detail-cost {
  font-family: var(--font-sans);
  font-size: 0.8rem;
  letter-spacing: 0.02em;
  color: var(--color-text-secondary);
}

.detail-cost strong {
  color: var(--color-amber-300);
  font-weight: 600;
  font-family: var(--font-mono);
}

/* ── Description ── */

.detail-description {
  font-family: var(--font-serif-cjk);
  font-size: 0.86rem;
  letter-spacing: 0.01em;
  color: var(--color-text);
  line-height: 1.85;
  white-space: pre-wrap;
}

.detail-no-desc {
  font-family: var(--font-serif-cjk);
  font-size: 0.8rem;
  color: var(--color-text-muted);
  opacity: 0.7;
  font-style: italic;
}

/* ── Custom fields — ABSOLUTE-BAN `border-left` REMOVED ── */

.detail-field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0.5rem 0.625rem 0.5rem 1.25rem;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
}
.detail-field::before {
  content: '';
  position: absolute;
  left: 8px;
  top: 50%;
  width: 4px;
  height: 4px;
  margin-top: -2px;
  border-radius: 50%;
  background: var(--color-sage-400);
  box-shadow: 0 0 4px color-mix(in oklch, var(--color-sage-400) 50%, transparent);
}

.detail-field-label {
  font-family: var(--font-sans);
  font-size: 0.7rem;
  font-weight: 500;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.detail-field-value {
  font-family: var(--font-serif-cjk);
  font-size: 0.82rem;
  letter-spacing: 0.01em;
  color: var(--color-text);
  line-height: 1.65;
  word-break: break-word;
}
</style>
