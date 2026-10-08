/**
 * Test-only helpers for the ImagePanel composables (R7). A reactive path -> value
 * store stands in for the game state tree, with `setValue` recording every write
 * as `[path, deep-copied value]` so tests can pin the exact write sequence.
 */
import { reactive } from 'vue';
import { vi } from 'vitest';
import type { PanelTranslate } from './panel-deps';

export type StateWrites = Array<[string, unknown]>;

export function makeStateAccess(initial: Record<string, unknown> = {}) {
  const tree = reactive<Record<string, unknown>>({ ...initial });
  const writes: StateWrites = [];
  const get = <T = unknown>(path: string): T | undefined => tree[path] as T | undefined;
  const setValue = vi.fn((path: string, value: unknown) => {
    writes.push([path, JSON.parse(JSON.stringify(value ?? null))]);
    tree[path] = value;
  });
  return { tree, writes, get, setValue };
}

/** Identity translate: returns the key, plus the named values so tests can see them. */
export const identityT: PanelTranslate = (key, named) =>
  named ? `${key}|${JSON.stringify(named)}` : key;
