/**
 * useConfig — Configuration management composable for UI components
 *
 * Provides a typed accessor layer over the GamePack's configuration data.
 * UI components inject the active GamePack and use this composable to
 * read rule configs, preset data, and the state schema without needing
 * to understand the GamePack's internal structure.
 *
 * Why a composable instead of direct GamePack access:
 * 1. Null-safe — gracefully returns defaults when no pack is loaded
 * 2. Domain-scoped — components request only the config domain they need
 * 3. Consistent API — abstracts over the pack's `rules` / `presets` / `stateSchema`
 *    naming, which could change across pack versions
 *
 * Dependency: GamePack must be provided via `provide('gamePack', pack)`.
 *
 * Phase M4 — UI Composable Layer.
 */
import { computed, inject } from 'vue';
import type { ComputedRef } from 'vue';
import type { GamePack, PresetEntry } from '@/engine/types';

export interface UseConfigReturn {
  /** The injected GamePack (undefined if no pack is loaded) */
  pack: GamePack | undefined;
  /** Whether a GamePack has been injected and is available */
  hasPack: ComputedRef<boolean>;
  /** Retrieve a rule config by domain ID, with optional type narrowing */
  getConfig: <T = Record<string, unknown>>(domain: string) => T | undefined;
  /** Retrieve preset entries by key — always returns an array (empty if missing) */
  getPresets: (key: string) => PresetEntry[];
  /** Retrieve raw preset data including primitives — for cases where entries may not be objects */
  getRawPresets: (key: string) => unknown[];
  /** Retrieve the full state schema object */
  getStateSchema: () => Record<string, unknown>;
  /** Retrieve prompt flow config by flow ID */
  getPromptFlow: (flowId: string) => Record<string, unknown> | undefined;
  /** Retrieve the pack's display settings (optional, pack-defined) */
  getDisplaySettings: () => Record<string, unknown>;
  /** Retrieve the pack's theme config (optional, pack-defined) */
  getTheme: () => Record<string, unknown>;
  /** Retrieve i18n text for a given locale and key */
  getI18nText: (locale: string, key: string) => string | undefined;
}

export function useConfig(): UseConfigReturn {
  const pack = inject<GamePack>('gamePack');

  const hasPack = computed(() => pack != null);

  /**
   * Retrieve a rule config by domain ID.
   *
   * GamePack.rules is `Record<string, unknown>`, so the caller uses
   * the generic parameter `T` to assert the expected shape. This is
   * safe because rule schemas are validated at pack-load time by
   * the config system.
   */
  function getConfig<T = Record<string, unknown>>(domain: string): T | undefined {
    if (!pack) return undefined;

    const config = pack.rules[domain];
    if (config === undefined || config === null) return undefined;

    return config as T;
  }

  /**
   * Retrieve preset entries filtered to object-only values.
   *
   * Most presets are arrays of objects (e.g., world options, talent pools).
   * This accessor filters out any non-object entries for type safety.
   * Use `getRawPresets` if you need the unfiltered array.
   */
  function getPresets(key: string): PresetEntry[] {
    if (!pack) return [];

    const entries = pack.presets[key];
    if (!Array.isArray(entries)) return [];

    return entries.filter(
      (entry): entry is PresetEntry =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
  }

  /**
   * Retrieve raw preset data without type filtering.
   * Use when preset entries may be primitives (strings, numbers).
   */
  function getRawPresets(key: string): unknown[] {
    if (!pack) return [];
    return pack.presets[key] ?? [];
  }

  function getStateSchema(): Record<string, unknown> {
    return pack?.stateSchema ?? {};
  }

  /**
   * Retrieve a prompt flow config by ID.
   * Returns the flow as a generic record; callers that need the typed
   * PromptFlowConfig should import and assert the type themselves.
   */
  function getPromptFlow(flowId: string): Record<string, unknown> | undefined {
    if (!pack) return undefined;
    const flow = pack.promptFlows[flowId];
    if (!flow) return undefined;
    // PromptFlowConfig is a typed interface; return as Record for generality
    return flow as unknown as Record<string, unknown>;
  }

  function getDisplaySettings(): Record<string, unknown> {
    return pack?.displaySettings ?? {};
  }

  function getTheme(): Record<string, unknown> {
    return pack?.theme ?? {};
  }

  /**
   * Look up a single i18n string by locale and key.
   *
   * GamePack.i18n is structured as `{ [locale]: { [key]: text } }`.
   * Returns undefined if the pack has no i18n data or the key is missing.
   */
  function getI18nText(locale: string, key: string): string | undefined {
    if (!pack?.i18n) return undefined;
    return pack.i18n[locale]?.[key];
  }

  return {
    pack,
    hasPack,
    getConfig,
    getPresets,
    getRawPresets,
    getStateSchema,
    getPromptFlow,
    getDisplaySettings,
    getTheme,
    getI18nText,
  };
}
