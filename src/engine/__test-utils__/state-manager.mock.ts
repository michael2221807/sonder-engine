/**
 * StateManager mock — in-memory stub for unit tests.
 *
 * Tracks all mutations for assertion. Uses lodash get/set internally
 * but no Vue reactive (tests don't need reactivity).
 *
 * CR-fix 2026-04-12: Added filter path resolution, loadTree, toSnapshot,
 * rollbackTo, clear, getChangeHistory, isLoaded.
 */
import { get as _get, set as _set, unset as _unset, cloneDeep } from 'lodash-es';

export interface MutationRecord {
  method: 'set' | 'delete' | 'push' | 'pull' | 'add';
  path: string;
  value?: unknown;
}

export interface MockStateManager {
  get<T = unknown>(path: string): T | undefined;
  has(path: string): boolean;
  set(path: string, value: unknown, source?: string): void;
  delete(path: string, source?: string): void;
  push(path: string, value: unknown, source?: string): void;
  pull(path: string, value: unknown, source?: string): void;
  add(path: string, value: number, source?: string): void;
  loadTree(data: Record<string, unknown>): void;
  toSnapshot(): Record<string, unknown>;
  rollbackTo(snapshot: Record<string, unknown>, keep?: readonly string[]): void;
  clear(): void;
  isLoaded(): boolean;
  readonly _data: Record<string, unknown>;
}

/**
 * Resolve filter path syntax: `arr[field=value].rest` → `arr.{index}.rest`
 * Matches the real StateManager's _resolveFilterPath behavior.
 */
const FILTER_RE = /([\w\u4e00-\u9fff]+)\[(\w[\w\u4e00-\u9fff]*)=([^\]]+)\]/;

function resolveFilterPath(path: string, data: Record<string, unknown>): string | null {
  if (!path.includes('[')) return path; // fast path

  const segments = path.split('.');
  const resolved: string[] = [];

  for (const seg of segments) {
    const match = seg.match(FILTER_RE);
    if (!match) {
      resolved.push(seg);
      continue;
    }
    const [, arrayKey, filterField, filterValue] = match;
    resolved.push(arrayKey);

    const arr = _get(data, resolved.join('.'));
    if (!Array.isArray(arr)) return null;

    const idx = arr.findIndex(
      (item) => item && typeof item === 'object' && String((item as Record<string, unknown>)[filterField]) === filterValue,
    );
    if (idx < 0) return null;
    resolved.push(String(idx));
  }

  return resolved.join('.');
}

export function createMockStateManager(
  initialData: Record<string, unknown> = {},
): { sm: MockStateManager; mutations: MutationRecord[] } {
  let data = cloneDeep(initialData) as Record<string, unknown>;
  let loaded = Object.keys(data).length > 0;
  const mutations: MutationRecord[] = [];

  const sm: MockStateManager = {
    get<T = unknown>(path: string): T | undefined {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) return undefined;
      return _get(data, resolved) as T | undefined;
    },

    has(path: string): boolean {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) return false;
      return _get(data, resolved) !== undefined;
    },

    set(path: string, value: unknown): void {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) return; // no-op for non-matching filter (no zombie fields)
      _set(data, resolved, value);
      mutations.push({ method: 'set', path, value });
    },

    delete(path: string): void {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) return;
      _unset(data, resolved);
      mutations.push({ method: 'delete', path });
    },

    push(path: string, value: unknown): void {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) {
        // No filter match — if path has no filter, create array
        if (!path.includes('[')) _set(data, path, [value]);
        mutations.push({ method: 'push', path, value });
        return;
      }
      const arr = _get(data, resolved);
      if (Array.isArray(arr)) {
        arr.push(value);
      } else {
        _set(data, resolved, [value]);
      }
      mutations.push({ method: 'push', path, value });
    },

    pull(path: string, value: unknown): void {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) return;
      const arr = _get(data, resolved);
      if (Array.isArray(arr)) {
        const idx = arr.indexOf(value);
        if (idx >= 0) arr.splice(idx, 1);
      }
      mutations.push({ method: 'pull', path, value });
    },

    add(path: string, value: number): void {
      const resolved = resolveFilterPath(path, data);
      if (!resolved) return;
      const current = (_get(data, resolved) as number) ?? 0;
      _set(data, resolved, current + value);
      mutations.push({ method: 'add', path, value });
    },

    loadTree(newData: Record<string, unknown>): void {
      const cloned = cloneDeep(newData);
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, cloned);
      loaded = true;
    },

    toSnapshot(): Record<string, unknown> {
      return cloneDeep(data);
    },

    rollbackTo(snapshot: Record<string, unknown>, keep: readonly string[] = []): void {
      const cloned = cloneDeep(snapshot);
      for (const path of keep) {
        const value = _get(data, path) as unknown;
        if (value !== undefined) _set(cloned, path, cloneDeep(value));
      }
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, cloned);
    },

    clear(): void {
      for (const key of Object.keys(data)) delete data[key];
      loaded = false;
    },

    isLoaded(): boolean {
      return loaded;
    },

    get _data() {
      return data;
    },
  };

  return { sm, mutations };
}
