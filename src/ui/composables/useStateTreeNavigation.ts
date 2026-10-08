/**
 * useStateTreeNavigation — 状态树浏览的纯逻辑 composable
 *
 * 抽出 GameVariablePanel.vue 的导航逻辑（selectedPath / breadcrumb / currentChildren /
 * fieldEntries / search），让 StateTreeBrowser.vue 能复用同一行为而不必复制 1000+ 行 UI。
 *
 * **设计选择：** 不修改 GameVariablePanel 本身（避免 1273 行文件的回归风险），
 * 仅作为新组件的逻辑后端。未来可选择性把 GameVariablePanel 重构为使用本 composable，
 * 但 MVP 阶段保持二者独立。
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md Phase 5a。
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue';
import { i18n } from '@/ui/i18n';

// ─── 类型 ───────────────────────────────────────────────

interface TreeNode {
  /** 当前层级的 key（如 "基础信息"） */
  key: string;
  /** 完整 dot-path（如 "角色.基础信息"） */
  fullPath: string;
  /** Locale-aware display label for the key (e.g. "Basic Info" in English mode) */
  displayKey: string;
  /** "string" / "number" / "boolean" / "object" / "array" / "null" */
  type: string;
  /** 子项数量（仅 object/array） */
  childCount: number;
  /** 人类可读的 preview（如 "13 项 · 首项: 王五"） */
  preview: string;
}

interface FieldEntry {
  key: string;
  path: string;
  value: unknown;
  type: string;
  /** true 当 type='object' 或 'array' */
  isComplex: boolean;
}

export interface UseStateTreeNavigationOptions {
  /** 状态树根 ref —— 通常来自 useGameState().tree */
  tree: Ref<unknown>;
  /** 取某 path 的值 —— 通常来自 useGameState().get */
  get: <T = unknown>(path: string) => T | undefined;
  /** 搜索时最大递归深度（GameVariablePanel 用 6） */
  searchMaxDepth?: number;
  /** 搜索结果上限 */
  searchMaxResults?: number;
  /**
   * Pack-level i18n data for the current locale (flat key-value).
   * Used to translate state tree path segments for display only.
   * Keys are formatted as `pathLabel.<segment>`, e.g. `pathLabel.角色` → "Character".
   * When absent or key is missing, the raw Chinese segment is used as-is.
   */
  pathLabels?: Ref<Record<string, string> | undefined>;
}

export interface StateTreeNavigation {
  selectedPath: Ref<string>;
  breadcrumb: ComputedRef<string[]>;
  /** Locale-translated breadcrumb segments (display only) */
  displayBreadcrumb: ComputedRef<string[]>;
  currentChildren: ComputedRef<TreeNode[]>;
  fieldEntries: ComputedRef<FieldEntry[]>;
  searchQuery: Ref<string>;
  searchResults: ComputedRef<SearchResult[]>;
  isSearching: ComputedRef<boolean>;
  navigateTo: (path: string) => void;
  navigateBreadcrumb: (index: number) => void;
  goBack: () => void;
  navigateToSearchResult: (path: string) => void;
  /** Translate a single path segment using pack pathLabels (display only) */
  translateSegment: (segment: string) => string;
}

interface SearchResult {
  path: string;
  value: unknown;
  type: string;
}

// ─── Helpers（与 GameVariablePanel 同实现） ───────────

export function getValueType(val: unknown): string {
  if (val === null || val === undefined) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function summarizeNode(_key: string, val: unknown): string {
  const t = i18n.global.t;
  if (val === null || val === undefined) return 'null';
  if (typeof val !== 'object') return truncate(String(val), 40);
  if (Array.isArray(val)) {
    if (val.length === 0) return t('common.navigation.emptyArray');
    const first = val[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const o = first as Record<string, unknown>;
      const name = o['名称'] ?? o['name'] ?? o['标题'] ?? o['title'] ?? o['id'] ?? o['subject'];
      if (name) return t('common.navigation.itemCountWithFirst', { count: val.length, first: truncate(String(name), 40) });
    }
    return t('common.navigation.itemCount', { count: val.length });
  }
  const obj = val as Record<string, unknown>;
  const nameField = obj['名称'] ?? obj['name'] ?? obj['姓名'] ?? obj['标题'] ?? obj['描述'];
  if (nameField && typeof nameField === 'string') return truncate(nameField, 40);
  const keys = Object.keys(obj);
  if (keys.length === 0) return t('common.navigation.emptyObject');
  const first = obj[keys[0]];
  if (typeof first === 'string') return `${keys[0]}: ${truncate(first, 35)}`;
  if (typeof first === 'number') return `${keys[0]}: ${first}`;
  return t('common.navigation.fieldCount', { count: keys.length });
}

// ─── Composable 主体 ───────────────────────────────────

/**
 * Translate a single path segment using pack-level pathLabel i18n data.
 * Returns the translated label if found, otherwise the raw segment.
 * This is a pure display helper — never affects data paths.
 */
export function getPathLabel(segment: string, packI18n?: Record<string, string>): string {
  if (!packI18n) return segment;
  return packI18n[`pathLabel.${segment}`] ?? segment;
}

export function useStateTreeNavigation(opts: UseStateTreeNavigationOptions): StateTreeNavigation {
  const selectedPath = ref<string>('');
  const searchQuery = ref<string>('');
  const maxDepth = opts.searchMaxDepth ?? 6;
  const maxResults = opts.searchMaxResults ?? 100;

  function translateSegment(segment: string): string {
    return getPathLabel(segment, opts.pathLabels?.value);
  }

  const breadcrumb = computed<string[]>(() =>
    selectedPath.value ? selectedPath.value.split('.') : [],
  );

  const displayBreadcrumb = computed<string[]>(() =>
    breadcrumb.value.map((seg) => translateSegment(seg)),
  );

  const currentChildren = computed<TreeNode[]>(() => {
    const value = selectedPath.value ? opts.get(selectedPath.value) : opts.tree.value;
    if (!value || typeof value !== 'object') return [];

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
        const displayKey = translateSegment(key);
        return { key, fullPath, displayKey, type, childCount, preview: summarizeNode(key, val) };
      });
  });

  const fieldEntries = computed<FieldEntry[]>(() => {
    const value = selectedPath.value ? opts.get(selectedPath.value) : opts.tree.value;
    if (!value || typeof value !== 'object') return [];
    const obj = Array.isArray(value)
      ? Object.fromEntries(value.map((v, i) => [String(i), v]))
      : (value as Record<string, unknown>);
    return Object.keys(obj).sort().map((key) => {
      const path = selectedPath.value ? `${selectedPath.value}.${key}` : key;
      const val = obj[key];
      const type = getValueType(val);
      return { key, path, value: val, type, isComplex: type === 'object' || type === 'array' };
    });
  });

  function flattenTree(obj: unknown, prefix: string, results: SearchResult[], depth: number): void {
    if (depth <= 0 || !obj || typeof obj !== 'object') return;
    const record = obj as Record<string, unknown>;
    for (const [key, val] of Object.entries(record)) {
      const path = prefix ? `${prefix}.${key}` : key;
      results.push({ path, value: val, type: getValueType(val) });
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        flattenTree(val, path, results, depth - 1);
      }
    }
  }

  const searchResults = computed<SearchResult[]>(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return [];
    const all: SearchResult[] = [];
    flattenTree(opts.tree.value, '', all, maxDepth);
    return all.filter((r) => r.path.toLowerCase().includes(q)).slice(0, maxResults);
  });

  const isSearching = computed(() => searchQuery.value.trim().length > 0);

  function navigateTo(path: string): void {
    selectedPath.value = path;
  }

  function navigateBreadcrumb(index: number): void {
    if (index < 0) selectedPath.value = '';
    else selectedPath.value = breadcrumb.value.slice(0, index + 1).join('.');
  }

  function goBack(): void {
    if (breadcrumb.value.length === 0) return;
    navigateBreadcrumb(breadcrumb.value.length - 2);
  }

  function navigateToSearchResult(path: string): void {
    const segments = path.split('.');
    if (segments.length > 1) selectedPath.value = segments.slice(0, -1).join('.');
    else selectedPath.value = '';
    searchQuery.value = '';
  }

  return {
    selectedPath, breadcrumb, displayBreadcrumb, currentChildren, fieldEntries,
    searchQuery, searchResults, isSearching,
    navigateTo, navigateBreadcrumb, goBack, navigateToSearchResult,
    translateSegment,
  };
}
