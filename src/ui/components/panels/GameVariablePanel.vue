<script setup lang="ts">
// App doc: docs/user-guide/pages/game-variables.md
/**
 * GameVariablePanel — STEP-03B M4.3 Layer 2 统一数据编辑中心。
 *
 * 已实现：树导航、按路径字段列表、搜索（浅层 flatten）、简单类型内联编辑、
 * SchemaForm 编辑对象、与 `getStateSchema()` 对比的「重置」提示。
 * Phase 6.3 新增：导出 JSON + 统计 Modal + 每字段复制按钮。
 */
import { ref, computed, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useGameState } from '@/ui/composables/useGameState';
import { useConfig } from '@/ui/composables/useConfig';
import { getPathLabel } from '@/ui/composables/useStateTreeNavigation';
import SearchInput from '@/ui/components/shared/SearchInput.vue';
import Modal from '@/ui/components/shared/Modal.vue';
import SchemaForm from '@/ui/components/editing/SchemaForm.vue';
import AgaButton from '@/ui/components/shared/AgaButton.vue';
import Tooltip from '@/ui/components/shared/Tooltip.vue';
import { eventBus } from '@/engine/core/event-bus';

const { t, locale } = useI18n();

const { isLoaded, tree, get, setValue } = useGameState();
const { getStateSchema, pack } = useConfig();
const route = useRoute();
const router = useRouter();

const returnPanel = computed(() => (route.query.from as string) ?? '');
const returnPanelLabel = computed(() => {
  const map: Record<string, string> = {
    character: t('character.tab.basic'),
    relationships: t('relationship.title'),
    map: t('map.title'),
    inventory: t('inventory.title'),
  };
  return map[returnPanel.value] ?? returnPanel.value;
});
function goBack(): void {
  if (returnPanel.value) {
    router.push({ path: `/game/${returnPanel.value}` });
  }
}

// Pack-level i18n data for translating state tree path segments (display only)
const packI18n = computed<Record<string, string> | undefined>(() => {
  if (!pack?.i18n) return undefined;
  return pack.i18n[locale.value];
});

/** Translate a single path segment for display using pack pathLabels */
function translateSegment(segment: string): string {
  return getPathLabel(segment, packI18n.value);
}

// ─── Tree navigation ───

const selectedPath = ref<string>('');
const breadcrumb = computed<string[]>(() =>
  selectedPath.value ? selectedPath.value.split('.') : [],
);

/** Translated breadcrumb segments for display */
const displayBreadcrumb = computed<string[]>(() =>
  breadcrumb.value.map((seg) => translateSegment(seg)),
);

/** Children of the currently selected path */
interface TreeNode {
  key: string;
  fullPath: string;
  displayKey: string;
  type: string;
  childCount: number;
  preview: string;
}

const currentChildren = computed<TreeNode[]>(() => {
  const value = selectedPath.value ? get<unknown>(selectedPath.value) : tree.value;
  if (!value || typeof value !== 'object') return [];

  // 统一处理：对象和数组都展示其子项为可导航节点
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);

  return entries
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, val]) => {
      const fullPath = selectedPath.value ? `${selectedPath.value}.${key}` : key;
      const type = getValueType(val);
      let childCount = 0;
      if (val && typeof val === 'object') {
        childCount = Array.isArray(val) ? val.length : Object.keys(val as Record<string, unknown>).length;
      }
      const preview = summarizeNode(key, val);
      const displayKey = translateSegment(key);
      return { key, fullPath, displayKey, type, childCount, preview };
    });
});

/**
 * 安全截断 —— 超过 n 个字符则切到 n 并追加 `…`
 *
 * 2026-04-13 fix：之前各 preview 函数直接用 `s.slice(0, N)` 静默截断，
 * 不加省略号。当真实数据的字符数恰好等于 N+1（比如"中国·云南省·昆明市·翠湖宾馆·总统套房B"
 * 共 21 字符，slice(0,20) 恰好切掉尾部 "B"），用户看 preview 以为数据就是这样，
 * 实则数据里还有内容。修复：统一走此工具函数，保证超长时一定显示 `…`。
 */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** 为 tree node 生成人类可读的摘要文本 */
function summarizeNode(_key: string, val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') {
    return truncate(String(val), 40);
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return t('variable.preview.empty');
    const first = val[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const o = first as Record<string, unknown>;
      const name = o['名称'] ?? o['name'] ?? o['标题'] ?? o['title'] ?? o['id'] ?? o['subject'];
      if (name) return t('variable.preview.firstItem', { count: val.length, name: truncate(String(name), 40) });
    }
    return t('variable.preview.itemCount', { count: val.length });
  }
  const obj = val as Record<string, unknown>;
  const nameField = obj['名称'] ?? obj['name'] ?? obj['姓名'] ?? obj['标题'] ?? obj['描述'];
  if (nameField && typeof nameField === 'string') return truncate(nameField, 40);
  const keys = Object.keys(obj);
  if (keys.length === 0) return t('variable.preview.empty');
  const first = obj[keys[0]];
  if (typeof first === 'string') return `${keys[0]}: ${truncate(first, 35)}`;
  if (typeof first === 'number') return `${keys[0]}: ${first}`;
  return t('variable.preview.fieldCount', { count: keys.length });
}

/** Navigate into a tree key */
function navigateTo(path: string): void {
  selectedPath.value = path;
}

watch(() => route.query.path as string | undefined, (path) => {
  if (path) navigateTo(path);
}, { immediate: true });

/** Navigate via breadcrumb */
function navigateBreadcrumb(index: number): void {
  if (index < 0) {
    selectedPath.value = '';
  } else {
    selectedPath.value = breadcrumb.value.slice(0, index + 1).join('.');
  }
}

// ─── Field display and editing ───

interface FieldEntry {
  key: string;
  path: string;
  value: unknown;
  type: string;
  isComplex: boolean;
  defaultValue: unknown;
  isDifferentFromDefault: boolean;
}

/** Get the resolved field list for the current path */
const fieldEntries = computed<FieldEntry[]>(() => {
  const value = selectedPath.value ? get<unknown>(selectedPath.value) : tree.value;
  if (!value || typeof value !== 'object') return [];

  const obj = Array.isArray(value) ? Object.fromEntries(value.map((v, i) => [String(i), v])) : value as Record<string, unknown>;
  const schema = getSubSchema(selectedPath.value);
  const defaultObj = getSchemaDefaults(schema);

  return Object.keys(obj)
    .sort()
    .map((key) => {
      const path = selectedPath.value ? `${selectedPath.value}.${key}` : key;
      const val = obj[key];
      const type = getValueType(val);
      const isComplex = type === 'object' || type === 'array';
      const defVal = defaultObj[key];
      const isDifferentFromDefault = defVal !== undefined && JSON.stringify(val) !== JSON.stringify(defVal);
      return { key, path, value: val, type, isComplex, defaultValue: defVal, isDifferentFromDefault };
    });
});

// ─── Search ───

const searchQuery = ref('');

interface SearchResult {
  path: string;
  value: unknown;
  type: string;
}

/** Flatten state tree into dot-path entries for search */
function flattenTree(obj: unknown, prefix: string, results: SearchResult[], maxDepth: number): void {
  if (maxDepth <= 0 || !obj || typeof obj !== 'object') return;

  const record = obj as Record<string, unknown>;
  for (const [key, val] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const type = getValueType(val);
    results.push({ path, value: val, type });

    if (val && typeof val === 'object' && !Array.isArray(val)) {
      flattenTree(val, path, results, maxDepth - 1);
    }
  }
}

const searchResults = computed<SearchResult[]>(() => {
  if (!searchQuery.value.trim()) return [];
  const q = searchQuery.value.trim().toLowerCase();
  const all: SearchResult[] = [];
  flattenTree(tree.value, '', all, 6);
  return all.filter((r) => r.path.toLowerCase().includes(q)).slice(0, 100);
});

const isSearching = computed(() => searchQuery.value.trim().length > 0);

function navigateToSearchResult(path: string): void {
  const segments = path.split('.');
  if (segments.length > 1) {
    selectedPath.value = segments.slice(0, -1).join('.');
  } else {
    selectedPath.value = '';
  }
  searchQuery.value = '';
}

// ─── Inline editing ───

const editingPath = ref<string | null>(null);
const editValue = ref('');

function startEdit(field: FieldEntry): void {
  if (field.isComplex) {
    // 数组和无 schema properties 的对象：导航进去（tree view 已支持数组）
    // SchemaForm 只能编辑有 properties 的 object schema，对数组会渲染空 modal
    const subSchema = getSubSchema(field.path);
    const hasProperties = !!(subSchema['properties'] && Object.keys(subSchema['properties'] as object).length > 0);
    if (!hasProperties) {
      navigateTo(field.path);
      return;
    }
    openSchemaEdit(field.path, field.key);
    return;
  }
  if (field.type === 'string') {
    openStringEdit(field);
    return;
  }
  editingPath.value = field.path;
  editValue.value = field.type === 'boolean' ? '' : String(field.value ?? '');
}

function commitEdit(field: FieldEntry): void {
  if (!editingPath.value) return;
  let parsed: unknown;
  switch (field.type) {
    case 'number':
      parsed = Number(editValue.value);
      if (isNaN(parsed as number)) parsed = 0;
      break;
    case 'boolean':
      parsed = !(field.value as boolean);
      break;
    default:
      parsed = editValue.value;
  }
  setValue(field.path, parsed);
  editingPath.value = null;
  eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.valueUpdated'), duration: 1200 });
}

function cancelEdit(): void {
  editingPath.value = null;
}

function toggleBoolean(field: FieldEntry): void {
  setValue(field.path, !(field.value as boolean));
  eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.valueUpdated'), duration: 1200 });
}

const pendingResetField = ref<FieldEntry | null>(null);

function confirmResetField(field: FieldEntry): void {
  pendingResetField.value = field;
}

function executeResetField(): void {
  if (!pendingResetField.value) return;
  setValue(pendingResetField.value.path, pendingResetField.value.defaultValue);
  eventBus.emit('ui:toast', { type: 'info', message: t('variable.toast.resetDone'), duration: 1200 });
  pendingResetField.value = null;
}

function cancelReset(): void {
  pendingResetField.value = null;
}

// ─── String edit modal ───

const showStringModal = ref(false);
const stringEditPath = ref('');
const stringEditKey = ref('');
const stringEditValue = ref('');

function openStringEdit(field: FieldEntry): void {
  stringEditPath.value = field.path;
  stringEditKey.value = field.key;
  stringEditValue.value = String(field.value ?? '');
  showStringModal.value = true;
}

function saveStringEdit(): void {
  setValue(stringEditPath.value, stringEditValue.value);
  showStringModal.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.valueUpdated'), duration: 1200 });
}

// ─── SchemaForm modal for complex types ───

const showSchemaModal = ref(false);
const schemaModalPath = ref('');
const schemaModalTitle = ref('');
const schemaModalData = ref<unknown>({});

function openSchemaEdit(path: string, title: string): void {
  const data = get<unknown>(path);
  schemaModalPath.value = path;
  schemaModalTitle.value = t('variable.schemaEdit.titlePrefix', { title });
  schemaModalData.value = data != null ? JSON.parse(JSON.stringify(data)) : {};
  showSchemaModal.value = true;
}

function onSchemaUpdate(newValue: unknown): void {
  schemaModalData.value = newValue;
}

function saveSchemaEdit(): void {
  setValue(schemaModalPath.value, schemaModalData.value);
  showSchemaModal.value = false;
  eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.dataSaved'), duration: 1500 });
}

// ─── Raw JSON editor modal ───

const showJsonEditor = ref(false);
const jsonEditorPath = ref('');
const jsonEditorTitle = ref('');
const jsonEditorText = ref('');
const jsonEditorError = ref('');

function openJsonEditor(path: string): void {
  const val = get<unknown>(path);
  jsonEditorPath.value = path;
  jsonEditorTitle.value = path || t('variable.breadcrumb.root');
  jsonEditorText.value = JSON.stringify(val, null, 2) ?? '{}';
  jsonEditorError.value = '';
  showJsonEditor.value = true;
}

function validateJsonEditor(): void {
  try {
    JSON.parse(jsonEditorText.value);
    jsonEditorError.value = '';
  } catch (e) {
    jsonEditorError.value = e instanceof Error ? e.message : t('variable.jsonEditor.formatError');
  }
}

const jsonEditorValid = computed(() => !jsonEditorError.value && jsonEditorText.value.trim().length > 0);

function saveJsonEditor(): void {
  try {
    const parsed = JSON.parse(jsonEditorText.value);
    setValue(jsonEditorPath.value, parsed);
    showJsonEditor.value = false;
    eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.jsonSaved'), duration: 1500 });
  } catch (e) {
    jsonEditorError.value = e instanceof Error ? e.message : t('variable.jsonEditor.formatError');
  }
}

function formatJsonEditor(): void {
  try {
    const parsed = JSON.parse(jsonEditorText.value);
    jsonEditorText.value = JSON.stringify(parsed, null, 2);
    jsonEditorError.value = '';
  } catch { /* keep as-is if invalid */ }
}

// ─── Helpers ───

function getValueType(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

function displayValue(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      if (val.length === 0) return t('variable.preview.emptyArray');
      const preview = val.slice(0, 2).map((item) => {
        if (typeof item === 'string') return `"${truncate(item, 40)}"`;
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          const name = o['名称'] ?? o['name'] ?? o['标题'] ?? o['id'];
          if (name) return truncate(String(name), 40);
          const firstVal = Object.values(o)[0];
          return typeof firstVal === 'string' ? truncate(firstVal, 30) : '{…}';
        }
        return String(item);
      }).join(', ');
      return `[${t('variable.preview.itemCount', { count: val.length })}] ${preview}${val.length > 2 ? ', …' : ''}`;
    }
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return t('variable.preview.emptyObject');
    const preview = keys.slice(0, 3).map((k) => {
      const v = obj[k];
      if (typeof v === 'string') return `${k}: "${truncate(v, 30)}"`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
      return `${k}: …`;
    }).join(', ');
    return `{${keys.length}} ${preview}${keys.length > 3 ? ', …' : ''}`;
  }
  return truncate(String(val), 80);
}

function typeColor(type: string): string {
  switch (type) {
    case 'string': return 'oklch(0.723 0.191 149.58)';
    case 'number': return 'oklch(0.623 0.168 259.09)';
    case 'boolean': return 'oklch(0.748 0.153 68.85)';
    case 'object': return 'oklch(0.585 0.208 277.12)';
    case 'array': return '#e879a0';
    case 'null': return '#8888a0';
    default: return '#8888a0';
  }
}

/** Get sub-schema for a dot-path */
function getSubSchema(dotPath: string): Record<string, unknown> {
  const schema = getStateSchema();
  if (!dotPath) return schema;
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = schema;
  for (const seg of segments) {
    const props = current['properties'] as Record<string, Record<string, unknown>> | undefined;
    if (props?.[seg]) {
      current = props[seg];
    } else {
      return {};
    }
  }
  return current;
}

/** Extract default values from schema properties */
function getSchemaDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  if (!props) return {};
  const defaults: Record<string, unknown> = {};
  for (const [key, fieldSchema] of Object.entries(props)) {
    if ('default' in fieldSchema) {
      defaults[key] = fieldSchema['default'];
    }
  }
  return defaults;
}

const modalSchema = computed(() => getSubSchema(schemaModalPath.value));

// ─── Phase 6.3: Export JSON ───────────────────────────────────

function exportStateJson(): void {
  const data = {
    saveData: tree.value,
    exportedAt: new Date().toISOString(),
  };
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `game-state-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.stateExported'), duration: 1500 });
}

// ─── Phase 6.3: Stats Modal ───────────────────────────────────

const showStatsModal = ref(false);

function countLeafNodes(obj: unknown): number {
  if (obj === null || obj === undefined) return 1;
  if (typeof obj !== 'object') return 1;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return 1;
    return obj.reduce((sum, item) => sum + countLeafNodes(item), 0);
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return 1;
  return keys.reduce((sum, k) => sum + countLeafNodes(record[k]), 0);
}

function treeDepth(obj: unknown, depth = 0): number {
  if (obj === null || obj === undefined || typeof obj !== 'object') return depth;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return depth + 1;
    return Math.max(...obj.map((item) => treeDepth(item, depth + 1)));
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return depth + 1;
  return Math.max(...keys.map((k) => treeDepth(record[k], depth + 1)));
}

const stateStats = computed(() => {
  const json = JSON.stringify(tree.value);
  const sizeKb = (json.length / 1024).toFixed(1);
  const leafCount = countLeafNodes(tree.value);
  const depth = treeDepth(tree.value);
  const rootKeys = tree.value ? Object.keys(tree.value as Record<string, unknown>).length : 0;
  return { sizeKb, leafCount, depth, rootKeys };
});

// ─── Phase 6.3: Copy field value ─────────────────────────────

async function copyFieldValue(path: string): Promise<void> {
  const val = get<unknown>(path);
  const text = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Fallback for non-secure contexts
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    eventBus.emit('ui:toast', { type: 'success', message: t('variable.toast.copied'), duration: 1000 });
  } catch {
    eventBus.emit('ui:toast', { type: 'error', message: t('variable.toast.copyFailed'), duration: 1500 });
  }
}
</script>

<template>
  <div class="gv-panel">
    <template v-if="isLoaded">
      <!-- ─── Header ─── -->
      <header class="panel-header">
        <div class="panel-title-group">
          <AgaButton v-if="returnPanel" variant="ghost" size="sm" @click="goBack">← {{ returnPanelLabel }}</AgaButton>
          <h2 class="panel-title">{{ t('variable.title') }}</h2>
        </div>
        <div class="header-actions">
          <AgaButton variant="ghost" size="sm" @click="showStatsModal = true">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path d="M2 11a1 1 0 011-1h2a1 1 0 011 1v5a1 1 0 01-1 1H3a1 1 0 01-1-1v-5zm6-4a1 1 0 011-1h2a1 1 0 011 1v9a1 1 0 01-1 1H9a1 1 0 01-1-1V7zm6-3a1 1 0 011-1h2a1 1 0 011 1v12a1 1 0 01-1 1h-2a1 1 0 01-1-1V4z"/></svg>
            {{ t('variable.stats') }}
          </AgaButton>
          <AgaButton variant="primary" size="sm" @click="exportStateJson">
            <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
            {{ t('variable.exportJson') }}
          </AgaButton>
        </div>
      </header>

      <!-- ─── Search bar ─── -->
      <SearchInput v-model="searchQuery" :placeholder="t('variable.search.placeholder')" :debounce-ms="200" />

      <!-- ─── Search results overlay ─── -->
      <div v-if="isSearching" class="search-results">
        <div class="search-results-header">
          {{ t('variable.search.resultsTitle', { count: searchResults.length }) }}
        </div>
        <div v-if="searchResults.length" class="search-result-list">
          <div
            v-for="result in searchResults"
            :key="result.path"
            class="search-result-item"
            @click="navigateToSearchResult(result.path)"
          >
            <span class="result-path">{{ result.path }}</span>
            <span class="result-value" :style="{ color: typeColor(result.type) }">
              {{ displayValue(result.value) }}
            </span>
          </div>
        </div>
        <p v-else class="empty-hint">{{ t('variable.search.noResults') }}</p>
      </div>

      <!-- ─── Main content (hidden during search) ─── -->
      <div v-else class="gv-content">
        <!-- Breadcrumb + JSON edit action -->
        <div class="breadcrumb-bar">
          <nav class="breadcrumb" :aria-label="t('variable.breadcrumb.root')">
            <button class="breadcrumb-item breadcrumb-item--root" @click="navigateBreadcrumb(-1)">
              {{ t('variable.breadcrumb.root') }}
            </button>
            <template v-for="(segment, idx) in displayBreadcrumb" :key="idx">
              <span class="breadcrumb-sep">/</span>
              <button
                :class="['breadcrumb-item', { 'breadcrumb-item--active': idx === breadcrumb.length - 1 }]"
                @click="navigateBreadcrumb(idx)"
              >
                {{ segment }}
              </button>
            </template>
          </nav>
          <Tooltip v-if="selectedPath" :text="t('variable.breadcrumb.jsonEdit')" interactive>
            <AgaButton variant="ghost" size="sm" @click="openJsonEditor(selectedPath)">
              { } JSON
            </AgaButton>
          </Tooltip>
        </div>

        <!-- Two-column layout -->
        <div :class="['gv-columns', { 'gv-columns--detail-open': !!selectedPath }]">
          <!-- Left: tree navigation -->
          <aside class="tree-nav">
            <Tooltip
              v-for="child in currentChildren"
              :key="child.fullPath"
              :text="child.type === 'object' ? t('variable.tree.expandFolder') : child.type === 'array' ? t('variable.tree.viewList') : t('variable.tree.editField')"
              position="right"
            >
              <div
                :class="['tree-node', { 'tree-node--selected': selectedPath === child.fullPath, 'tree-node--navigable': child.type === 'object' || child.type === 'array' }]"
                @click="(child.type === 'object' || child.type === 'array') ? navigateTo(child.fullPath) : startEdit({ key: child.key, path: child.fullPath, value: get(child.fullPath), type: child.type, isComplex: false, defaultValue: undefined, isDifferentFromDefault: false })"
              >
                <span :class="['tree-node-icon', `tree-node-icon--${child.type}`]">
                  <svg v-if="child.type === 'object'" viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
                  <svg v-else-if="child.type === 'array'" viewBox="0 0 16 16" fill="currentColor" width="14" height="14"><path d="M2 4a1 1 0 100-2 1 1 0 000 2zm3.75-1.5a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5zm0 5a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5zm0 5a.75.75 0 000 1.5h8.5a.75.75 0 000-1.5h-8.5zM3 8a1 1 0 10-2 0 1 1 0 002 0zm-1 5a1 1 0 100-2 1 1 0 000 2z"/></svg>
                  <span v-else class="tree-node-dot" :style="{ background: typeColor(child.type) }" />
                </span>
                <span class="tree-node-name">{{ child.displayKey }}</span>
                <span class="tree-node-preview" :style="{ color: (child.type === 'object' || child.type === 'array') ? '#8888a0' : typeColor(child.type) }">
                  {{ child.preview }}
                </span>
                <span v-if="child.type === 'object' || child.type === 'array'" class="tree-node-arrow">›</span>
              </div>
            </Tooltip>
            <p v-if="!currentChildren.length" class="empty-hint">{{ t('variable.tree.emptyPath') }}</p>
          </aside>

          <!-- Right: field list for selected path -->
          <main class="field-list">
            <div v-if="!selectedPath" class="field-list-hint">
              <p>{{ t('variable.field.selectHint') }}</p>
            </div>
            <template v-else>
              <div
                v-for="field in fieldEntries"
                :key="field.path"
                class="field-row"
              >
                <div class="field-key-area">
                  <span class="field-key">{{ translateSegment(field.key) }}</span>
                  <span class="field-type-tag" :style="{ color: typeColor(field.type), borderColor: typeColor(field.type) }">
                    {{ field.type }}
                  </span>
                </div>

                <div class="field-value-area">
                  <!-- Boolean toggle -->
                  <template v-if="field.type === 'boolean'">
                    <button
                      :class="['bool-toggle', { 'bool-toggle--true': field.value }]"
                      @click="toggleBoolean(field)"
                    >
                      {{ field.value ? 'true' : 'false' }}
                    </button>
                  </template>

                  <!-- Inline editing for string/number -->
                  <template v-else-if="editingPath === field.path">
                    <input
                      v-model="editValue"
                      :type="field.type === 'number' ? 'number' : 'text'"
                      class="inline-edit"
                      @keydown.enter="commitEdit(field)"
                      @keydown.escape="cancelEdit"
                      @blur="commitEdit(field)"
                    />
                  </template>

                  <!-- Complex type (object/array) — click to navigate into tree -->
                  <template v-else-if="field.isComplex">
                    <button class="complex-btn" @click="navigateTo(field.path)">
                      {{ displayValue(field.value) }}
                    </button>
                  </template>

                  <!-- Display value — double-click to edit -->
                  <template v-else>
                    <Tooltip :text="t('variable.field.doubleClickEdit')">
                      <span
                        class="field-value"
                        :style="{ color: typeColor(field.type) }"
                        @dblclick="startEdit(field)"
                      >
                        {{ displayValue(field.value) }}
                      </span>
                    </Tooltip>
                  </template>

                  <!-- Copy button -->
                  <Tooltip :text="t('variable.field.copyValue')" interactive>
                    <button
                      class="copy-btn"
                      @click.stop="copyFieldValue(field.path)"
                    >
                      <svg viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
                    </button>
                  </Tooltip>
                  <!-- Reset (separated, with confirmation) -->
                  <Tooltip v-if="field.isDifferentFromDefault" :text="t('variable.field.resetDefault')" interactive>
                    <button
                      class="reset-btn"
                      @click.stop="confirmResetField(field)"
                    >
                      <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M7.793 2.232a.75.75 0 01-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 010 10.75H10.75a.75.75 0 010-1.5h2.875a3.875 3.875 0 000-7.75H3.622l4.146 3.957a.75.75 0 01-1.036 1.085l-5.5-5.25a.75.75 0 010-1.085l5.5-5.25a.75.75 0 011.06.025z" clip-rule="evenodd"/></svg>
                    </button>
                  </Tooltip>
                </div>
              </div>
              <p v-if="!fieldEntries.length" class="empty-hint">{{ t('variable.field.emptyFields') }}</p>
            </template>
          </main>
        </div>
      </div>
    </template>

    <div v-else class="empty-state">
      <p>{{ t('variable.notLoaded') }}</p>
    </div>

    <!-- ─── Stats Modal ─── -->
    <Modal v-model="showStatsModal" :title="t('variable.stats.title')" width="360px">
      <div class="stats-grid">
        <div class="stats-row">
          <span class="stats-label">{{ t('variable.stats.estimatedSize') }}</span>
          <span class="stats-value">{{ stateStats.sizeKb }} KB</span>
        </div>
        <div class="stats-row">
          <span class="stats-label">{{ t('variable.stats.leafCount') }}</span>
          <span class="stats-value">{{ stateStats.leafCount.toLocaleString() }}</span>
        </div>
        <div class="stats-row">
          <span class="stats-label">{{ t('variable.stats.maxDepth') }}</span>
          <span class="stats-value">{{ t('variable.stats.maxDepthUnit', { depth: stateStats.depth }) }}</span>
        </div>
        <div class="stats-row">
          <span class="stats-label">{{ t('variable.stats.rootKeys') }}</span>
          <span class="stats-value">{{ stateStats.rootKeys }}</span>
        </div>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showStatsModal = false">{{ t('variable.stats.close') }}</AgaButton>
        <AgaButton variant="primary" @click="exportStateJson; showStatsModal = false">{{ t('variable.exportJson') }}</AgaButton>
      </template>
    </Modal>

    <!-- ─── String Edit Modal ─── -->
    <Modal v-model="showStringModal" :title="t('variable.stringEdit.titlePrefix', { key: stringEditKey })" width="560px">
      <textarea
        v-model="stringEditValue"
        class="string-edit-textarea"
        rows="8"
        spellcheck="false"
      />
      <template #footer>
        <AgaButton variant="secondary" @click="showStringModal = false">{{ t('variable.common.cancel') }}</AgaButton>
        <AgaButton variant="primary" @click="saveStringEdit">{{ t('variable.common.save') }}</AgaButton>
      </template>
    </Modal>

    <!-- ─── SchemaForm Modal ─── -->
    <Modal v-model="showSchemaModal" :title="schemaModalTitle" width="600px">
      <SchemaForm
        :schema="modalSchema"
        :value="schemaModalData"
        @update:value="onSchemaUpdate"
      />
      <template #footer>
        <AgaButton variant="secondary" @click="showSchemaModal = false">{{ t('variable.common.cancel') }}</AgaButton>
        <AgaButton variant="primary" @click="saveSchemaEdit">{{ t('variable.common.save') }}</AgaButton>
      </template>
    </Modal>

    <!-- ─── Reset Confirmation ─── -->
    <Modal :model-value="!!pendingResetField" @update:model-value="cancelReset" :title="t('variable.confirmReset.title')" width="400px">
      <p v-if="pendingResetField" style="font-size: 0.88rem; line-height: 1.6; margin: 0;">
        {{ t('variable.confirmReset.text', { path: pendingResetField.path }) }}
      </p>
      <template #footer>
        <AgaButton variant="secondary" @click="cancelReset">{{ t('variable.common.cancel') }}</AgaButton>
        <AgaButton variant="danger" @click="executeResetField">{{ t('variable.confirmReset.confirm') }}</AgaButton>
      </template>
    </Modal>

    <!-- ─── Raw JSON Editor Modal ─── -->
    <Modal v-model="showJsonEditor" :title="t('variable.jsonEditor.titlePrefix', { title: jsonEditorTitle })" width="680px">
      <div class="json-editor">
        <div class="json-toolbar">
          <AgaButton variant="ghost" size="sm" @click="formatJsonEditor">{{ t('variable.jsonEditor.format') }}</AgaButton>
          <span v-if="jsonEditorError" class="json-error-badge">{{ t('variable.jsonEditor.invalid') }}</span>
          <span v-else class="json-ok-badge">{{ t('variable.jsonEditor.valid') }}</span>
        </div>
        <textarea
          v-model="jsonEditorText"
          class="json-textarea"
          :class="{ 'json-textarea--error': jsonEditorError }"
          spellcheck="false"
          @input="validateJsonEditor"
        />
        <p v-if="jsonEditorError" class="json-error-msg">{{ jsonEditorError }}</p>
      </div>
      <template #footer>
        <AgaButton variant="secondary" @click="showJsonEditor = false">{{ t('variable.common.cancel') }}</AgaButton>
        <AgaButton variant="primary" :disabled="!jsonEditorValid" @click="saveJsonEditor">{{ t('variable.common.save') }}</AgaButton>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.gv-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px var(--sidebar-right-reserve, 40px) 20px var(--sidebar-left-reserve, 40px);
  transition: padding-left var(--duration-open) var(--ease-droplet), padding-right var(--duration-open) var(--ease-droplet);
  height: 100%;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  gap: 6px;
}

.panel-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--color-text, #e0e0e6);
}

/* ── Search results ── */
.search-results {
  flex: 1;
  overflow-y: auto;
}

.search-results-header {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--color-text-secondary, #8888a0);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.search-result-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-result-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
  gap: 12px;
}
.search-result-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.result-path {
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.result-value {
  font-size: 0.75rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  opacity: 0.8;
  flex-shrink: 0;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Main content ── */
.gv-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 8px;
}

/* ── Breadcrumb bar ── */
.breadcrumb-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.breadcrumb {
  flex: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
}

.breadcrumb-item {
  padding: 2px 6px;
  font-size: 0.78rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-sage-400);
  background: none;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.15s ease;
}
.breadcrumb-item:hover {
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}
.breadcrumb-item--root {
  color: var(--color-text-secondary, #8888a0);
}
.breadcrumb-item--active {
  color: var(--color-text, #e0e0e6);
  font-weight: 600;
  cursor: default;
}

.breadcrumb-sep {
  font-size: 0.72rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.5;
}

/* ── Two-column layout ── */
.gv-columns {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

/* ── Left: tree nav ── */
.tree-nav {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.01);
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
  transition: background 0.12s ease;
}
.tree-node:hover {
  background: rgba(255, 255, 255, 0.04);
}
.tree-node--selected {
  background: color-mix(in oklch, var(--color-sage-400) 10%, transparent);
}

.tree-node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  flex-shrink: 0;
}
.tree-node-icon--object { color: var(--color-amber-300); }
.tree-node-icon--array { color: var(--color-sage-400); }
.tree-node-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.tree-node-name {
  color: var(--color-text, #e0e0e6);
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-node-count {
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 8px;
}

.tree-node-preview {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}

.tree-node-arrow {
  flex-shrink: 0;
  font-size: 1rem;
  color: var(--color-text-muted, #55556a);
  transition: transform var(--duration-fast, 120ms) var(--ease-out),
              color var(--duration-fast, 120ms) var(--ease-out);
}
.tree-node--navigable {
  cursor: pointer;
}
.tree-node--navigable:hover .tree-node-arrow {
  transform: translateX(2px);
  color: var(--color-sage-400);
}

/* ── Right: field list ── */
.field-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.field-list-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.85rem;
}

.field-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 6px;
  gap: 12px;
}
.field-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.field-key-area {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 220px;
  flex-shrink: 0;
}

.field-key {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--color-text, #e0e0e6);
}

.field-type-tag {
  font-size: 0.58rem;
  font-weight: 700;
  padding: 1px 5px;
  border: 1px solid;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.65;
  min-width: 48px;
  text-align: center;
  flex-shrink: 0;
}

.field-value-area {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  justify-content: flex-end;
  min-width: 0;
  overflow: hidden;
}

.field-value {
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ── Inline edit ── */
.inline-edit {
  height: 28px;
  padding: 0 8px;
  font-size: 0.82rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-text, #e0e0e6);
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-sage-400, #91c49b);
  border-radius: 5px;
  outline: none;
  max-width: 200px;
}
.inline-edit::-webkit-outer-spin-button,
.inline-edit::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.inline-edit[type='number'] {
  -moz-appearance: textfield;
  appearance: textfield;
}

.string-edit-textarea {
  width: 100%;
  min-height: 160px;
  padding: 12px;
  font-size: 0.84rem;
  font-family: var(--font-serif-cjk);
  line-height: 1.7;
  color: var(--color-text, #e0e0e6);
  background: var(--color-bg, #0f0f14);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px;
  outline: none;
  resize: vertical;
}
.string-edit-textarea:focus {
  border-color: var(--color-sage-400);
}

/* ── Boolean toggle ── */
.bool-toggle {
  padding: 2px 10px;
  font-size: 0.75rem;
  font-weight: 600;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-danger, #ef4444);
  cursor: pointer;
  transition: all 0.15s ease;
}
.bool-toggle--true {
  color: var(--color-success, #22c55e);
  border-color: color-mix(in oklch, var(--color-success) 25%, transparent);
  background: color-mix(in oklch, var(--color-success) 8%, transparent);
}

/* ── Complex value button ── */
.complex-btn {
  padding: 4px 10px;
  font-size: 0.78rem;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-sage-400);
  background: color-mix(in oklch, var(--color-sage-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-sage-400) 20%, transparent);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s ease;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  min-width: 0;
  text-align: right;
}
.complex-btn:hover {
  background: color-mix(in oklch, var(--color-sage-400) 15%, transparent);
}

/* ── Copy button ── */
.copy-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--color-text-secondary, #8888a0);
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
  opacity: 0;
}
.field-row:hover .copy-btn { opacity: 1; }
.copy-btn:hover {
  color: var(--color-text, #e0e0e6);
  background: rgba(255,255,255,0.08);
}

/* ── Stats modal ── */
.stats-grid {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}
.stats-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255,255,255,0.02);
  border-radius: 6px;
}
.stats-label {
  font-size: 0.82rem;
  color: var(--color-text-secondary, #8888a0);
}
.stats-value {
  font-size: 0.88rem;
  font-weight: 700;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--color-sage-400);
}

/* ── Reset button ── */
.reset-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 0.75rem;
  color: var(--color-warning, #f59e0b);
  background: color-mix(in oklch, var(--color-amber-400) 8%, transparent);
  border: 1px solid color-mix(in oklch, var(--color-amber-400) 20%, transparent);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.reset-btn:hover {
  background: var(--color-warning, #f59e0b);
  color: var(--color-bg);
}

/* ── Empty ── */
.empty-hint {
  font-size: 0.82rem;
  color: var(--color-text-secondary, #8888a0);
  opacity: 0.6;
  text-align: center;
  padding: 16px;
  margin: 0;
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-secondary, #8888a0);
  font-size: 0.88rem;
}

/* ── Scrollbar ── */
.tree-nav::-webkit-scrollbar,
.field-list::-webkit-scrollbar,
.search-results::-webkit-scrollbar { width: 4px; }
.tree-nav::-webkit-scrollbar-track,
.field-list::-webkit-scrollbar-track,
.search-results::-webkit-scrollbar-track { background: transparent; }
.tree-nav::-webkit-scrollbar-thumb,
.field-list::-webkit-scrollbar-thumb,
.search-results::-webkit-scrollbar-thumb { background: color-mix(in oklch, var(--color-text-umber) 35%, transparent); border-radius: 2px; }

/* ── JSON Editor Modal ── */
.json-editor { display: flex; flex-direction: column; gap: 8px; }
.json-toolbar { display: flex; align-items: center; gap: 8px; }
.json-error-badge {
  padding: 2px 8px; font-size: 0.68rem; font-weight: 600;
  background: color-mix(in oklch, var(--color-danger) 12%, transparent); color: var(--color-danger-hover);
  border-radius: 4px;
}
.json-ok-badge {
  padding: 2px 8px; font-size: 0.68rem; font-weight: 600;
  background: color-mix(in oklch, var(--color-success) 12%, transparent); color: var(--color-success);
  border-radius: 4px;
}
.json-textarea {
  width: 100%; min-height: 320px; max-height: 500px;
  padding: 12px; font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.82rem; line-height: 1.55; tab-size: 2;
  color: var(--color-text, #e8e8f0);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--color-border, #2a2a3a);
  border-radius: 8px; resize: vertical;
  transition: border-color 0.15s;
}
.json-textarea:focus { outline: none; border-color: var(--color-sage-400); }
.json-textarea--error { border-color: var(--color-danger) !important; }
.json-error-msg {
  margin: 0; font-size: 0.72rem; color: var(--color-danger-hover); line-height: 1.4;
  padding: 4px 8px; background: color-mix(in oklch, var(--color-danger) 6%, transparent);
  border-radius: 4px;
}

@media (max-width: 767px) {
  .gv-panel { padding-left: var(--space-md); padding-right: var(--space-md); transition: none; }

  /* Master-detail push: only one pane visible at a time */
  .gv-columns {
    flex-direction: column;
  }
  .tree-nav {
    width: 100%;
    flex: 1;
    min-height: 0;
  }
  .field-list {
    display: none;
  }

  /* Detail open: tree hides, field-list takes over */
  .gv-columns--detail-open .tree-nav {
    display: none;
  }
  .gv-columns--detail-open .field-list {
    display: flex;
    flex: 1;
    min-height: 0;
    width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .field-list-hint { display: none; }
  .field-row {
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: var(--space-xs);
  }
  .field-key-area {
    width: 100%;
    flex-shrink: 1;
  }
  .field-value-area {
    width: 100%;
    justify-content: flex-start;
    word-break: break-all;
    overflow-wrap: anywhere;
  }
  .field-value-area .inline-edit {
    width: 100%;
    box-sizing: border-box;
  }
  .field-value-text {
    word-break: break-all;
    overflow-wrap: anywhere;
  }
}

/* ── Story 2: Return link + title group ── */
.panel-title-group { display: flex; align-items: center; gap: 10px; }
</style>
