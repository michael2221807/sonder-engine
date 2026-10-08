<script setup lang="ts">
/**
 * StateTreeBrowser — 状态树浏览组件（无副作用，可选支持选择模式）
 *
 * 用途：
 * - AttachmentPickerModal 用 selectionMode='multi' + showOnlyEditable=true 让用户选 attach path
 * - 未来可让 GameVariablePanel 重构为本组件 wrapper（MVP 不做）
 *
 * 与 GameVariablePanel 的视觉一致：用 useStateTreeNavigation composable 共享导航逻辑。
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md Phase 5a。
 */
import { computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useGameState } from '@/ui/composables/useGameState';
import { useConfig } from '@/ui/composables/useConfig';
import { useStateTreeNavigation } from '@/ui/composables/useStateTreeNavigation';
import SearchInput from '@/ui/components/shared/SearchInput.vue';

const { t, locale } = useI18n();

const props = withDefaults(defineProps<{
  /** none: 仅浏览；single: 单选；multi: 多选（v-model:selectedPaths） */
  selectionMode?: 'none' | 'single' | 'multi';
  selectedPaths?: string[];
  /** 仅显示带 x-assistant-editable 标记的 path（基于 schema） */
  showOnlyEditable?: boolean;
  /** 当前选择的高亮 target path（仅 selectionMode='multi' 用于二分 context/target） */
  targetPath?: string | null;
}>(), {
  selectionMode: 'none',
  selectedPaths: () => [],
  showOnlyEditable: false,
  targetPath: null,
});

const emit = defineEmits<{
  'update:selectedPaths': [paths: string[]];
  'select': [path: string];
}>();

const { tree, get } = useGameState();
const { getStateSchema, pack } = useConfig();

// Pack-level i18n data for the current locale — provides pathLabel.* translations
const pathLabelsRef = computed<Record<string, string> | undefined>(() => {
  if (!pack?.i18n) return undefined;
  return pack.i18n[locale.value];
});

const nav = useStateTreeNavigation({ tree, get, pathLabels: pathLabelsRef });

// ─── x-assistant-editable 过滤 ──────────────────────

function getSubSchema(dotPath: string): Record<string, unknown> {
  const root = getStateSchema();
  if (!dotPath) return root;
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = root;
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      const items = current['items'];
      if (items && typeof items === 'object') { current = items as Record<string, unknown>; continue; }
      return {};
    }
    const props = current['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props?.[seg]) { current = props[seg]; continue; }
    const addProps = current['additionalProperties'];
    if (addProps && typeof addProps === 'object') { current = addProps as Record<string, unknown>; continue; }
    return {};
  }
  return current;
}

/** 检查 path 自身或祖先有 x-assistant-editable: true */
function isEditablePath(path: string): boolean {
  const root = getStateSchema();
  if (root['x-assistant-editable'] === true) return true;
  const segments = path.split('.').filter(Boolean);
  let current: Record<string, unknown> = root;
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      const items = current['items'];
      if (!items || typeof items !== 'object') return false;
      current = items as Record<string, unknown>;
      continue;
    }
    const props = current['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props?.[seg]) {
      current = props[seg];
      if (current['x-assistant-editable'] === true) return true;
      continue;
    }
    const addProps = current['additionalProperties'];
    if (addProps && typeof addProps === 'object') {
      current = addProps as Record<string, unknown>;
      continue;
    }
    return false;
  }
  return false;
}

/** 检查 path 子树中是否有 editable 节点（用于父节点显示与否） */
function hasEditableDescendant(path: string): boolean {
  const sub = getSubSchema(path);
  return findAnyEditable(sub);
}

function findAnyEditable(schema: Record<string, unknown>): boolean {
  if (schema['x-assistant-editable'] === true) return true;
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const v of Object.values(props)) {
      if (findAnyEditable(v)) return true;
    }
  }
  const items = schema['items'];
  if (items && typeof items === 'object' && findAnyEditable(items as Record<string, unknown>)) return true;
  return false;
}

const filteredChildren = computed(() => {
  const all = nav.currentChildren.value;
  if (!props.showOnlyEditable) return all;
  return all.filter((c) => isEditablePath(c.fullPath) || hasEditableDescendant(c.fullPath));
});

// ─── 选择 ────────────────────────────────────────────

const selectedSet = computed<Set<string>>(() => new Set(props.selectedPaths));

function isSelected(path: string): boolean {
  return selectedSet.value.has(path);
}

function isPathChoosable(path: string): boolean {
  if (props.selectionMode === 'none') return false;
  if (props.showOnlyEditable && !isEditablePath(path)) return false;
  return true;
}

function toggleSelect(path: string): void {
  if (!isPathChoosable(path)) return;
  if (props.selectionMode === 'single') {
    emit('update:selectedPaths', isSelected(path) ? [] : [path]);
    emit('select', path);
    return;
  }
  // multi
  const next = new Set(selectedSet.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  emit('update:selectedPaths', Array.from(next));
  emit('select', path);
}

// ─── Click handlers ──────────────────────────────────

function onChildClick(path: string, event: MouseEvent): void {
  // 单击进入；双击或 checkbox 用于选择
  // 这里：如果是叶子可选 → toggle；否则 navigate
  if (event.shiftKey && props.selectionMode !== 'none' && isPathChoosable(path)) {
    toggleSelect(path);
    return;
  }
  nav.navigateTo(path);
}

// 当 props.selectedPaths 从外部变化时 nav 不需要更新（selectedPaths 仅显示用）
watch(() => props.selectedPaths, () => { /* trigger reactivity */ }, { deep: true });
</script>

<template>
  <div class="state-tree-browser">
    <!-- Header: search + breadcrumb -->
    <div class="browser-header">
      <SearchInput v-model="nav.searchQuery.value" :placeholder="t('assistant.stateTree.searchPlaceholder')" />
      <div class="breadcrumb">
        <a href="#" class="crumb" @click.prevent="nav.navigateBreadcrumb(-1)">{{ t('assistant.stateTree.root') }}</a>
        <template v-for="(seg, i) in nav.displayBreadcrumb.value" :key="i">
          <span class="crumb-sep">/</span>
          <a href="#" class="crumb" @click.prevent="nav.navigateBreadcrumb(i)">{{ seg }}</a>
        </template>
      </div>
    </div>

    <!-- Search results -->
    <div v-if="nav.isSearching.value" class="search-results">
      <div
        v-for="r in nav.searchResults.value"
        :key="r.path"
        class="search-row"
        @click="nav.navigateToSearchResult(r.path)"
      >
        <span class="search-path">{{ r.path }}</span>
        <span class="search-type" :data-type="r.type">{{ r.type }}</span>
      </div>
      <div v-if="nav.searchResults.value.length === 0" class="empty-state">{{ t('assistant.stateTree.noMatch') }}</div>
    </div>

    <!-- Children list -->
    <div v-else class="children-list">
      <div v-if="filteredChildren.length === 0" class="empty-state">
        {{ showOnlyEditable ? t('assistant.stateTree.noEditablePaths') : t('assistant.stateTree.empty') }}
      </div>
      <div
        v-for="child in filteredChildren"
        :key="child.fullPath"
        class="child-row"
        :class="{
          selected: isSelected(child.fullPath),
          choosable: isPathChoosable(child.fullPath),
          'is-target': props.targetPath === child.fullPath,
        }"
      >
        <input
          v-if="props.selectionMode !== 'none' && isPathChoosable(child.fullPath)"
          type="checkbox"
          :checked="isSelected(child.fullPath)"
          class="child-checkbox"
          @click.stop="toggleSelect(child.fullPath)"
        />
        <div class="child-main" @click="onChildClick(child.fullPath, $event)">
          <span class="child-key">{{ child.displayKey }}</span>
          <span class="child-type" :data-type="child.type">{{ child.type }}</span>
          <span v-if="child.childCount > 0" class="child-count">{{ child.childCount }}</span>
          <span class="child-preview">{{ child.preview }}</span>
        </div>
        <span v-if="child.childCount > 0" class="child-arrow">›</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.state-tree-browser {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  font-size: 0.85rem;
}

.browser-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
}

.breadcrumb {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}
.crumb { color: var(--color-sage-400); text-decoration: none; }
.crumb:hover { text-decoration: underline; }
.crumb-sep { opacity: 0.5; }

.search-results, .children-list {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 4px;
}

.empty-state {
  padding: 20px;
  text-align: center;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.search-row, .child-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s;
}
.search-row:hover, .child-row:hover {
  background: color-mix(in oklch, var(--color-sage-400) 6%, transparent);
}

.child-row.selected {
  background: color-mix(in oklch, var(--color-sage-400) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--color-sage-400), 0 0 10px color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.child-row.is-target {
  background: color-mix(in oklch, var(--color-success) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--color-success);
}

.child-checkbox {
  margin: 0;
  cursor: pointer;
}

.child-main {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.child-key {
  font-weight: 500;
  color: var(--color-text);
  flex-shrink: 0;
}

.child-type {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in oklch, var(--color-text-umber) 10%, transparent);
  color: var(--color-text-secondary);
  text-shadow: 0 0 3px currentColor;
}
.child-type[data-type="string"]   { color: var(--color-success); }
.child-type[data-type="number"]   { color: var(--color-sage-300); }
.child-type[data-type="boolean"]  { color: var(--color-amber-400); }
.child-type[data-type="object"]   { color: var(--color-sage-400); }
.child-type[data-type="array"]    { color: var(--color-sage-300); }
.child-type[data-type="null"]     { color: var(--color-text-muted); }

.child-count {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  opacity: 0.7;
}

.child-preview {
  flex: 1 1 auto;
  font-size: 0.78rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.child-arrow {
  color: var(--color-text-secondary);
  font-size: 1rem;
}

.search-path { flex: 1; color: var(--color-text); font-family: monospace; font-size: 0.78rem; }
.search-type {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in oklch, var(--color-text-umber) 10%, transparent);
}
</style>
