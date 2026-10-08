/**
 * useTheme — Theme management composable
 *
 * Reads theme config from the injected GamePack and applies it as
 * CSS custom properties on the document root. This enables Game Pack
 * authors to fully customise the UI appearance via JSON config alone,
 * without writing CSS.
 *
 * Theming strategy:
 * - Pack authors define a `theme` object in their Game Pack
 *   (e.g., { "primaryColor": "#6366f1", "surfaceBg": "#1a1a2e" })
 * - This composable maps each key to a CSS variable using kebab-case
 *   (e.g., --color-primary-color, --color-surface-bg)
 * - Components reference these variables in their styles
 * - On mount, the pack's theme is applied; the theme can also be
 *   hot-swapped at runtime via `applyTheme()`
 *
 * Nested theme objects are flattened with dot-separated prefixes,
 * so `{ "button": { "borderRadius": "8px" } }` becomes
 * `--theme-button-border-radius: 8px`.
 *
 * Dependency: GamePack must be provided via `provide('gamePack', pack)`.
 *
 * Phase M4 — UI Composable Layer.
 */
import { ref, watch, onMounted } from 'vue';
import { injectService } from '@/ui/injection-keys';
import type { Ref } from 'vue';

/** Flat map of CSS variable name → value, for inspection/debugging */
type CSSVariableMap = Record<string, string>;

export interface UseThemeReturn {
  /** Apply a theme config object to the document root */
  applyTheme: (theme: Record<string, unknown>) => void;
  /** Remove all CSS variables previously set by this composable */
  clearTheme: () => void;
  /** Whether a theme has been applied */
  isApplied: Ref<boolean>;
  /** Snapshot of the currently applied CSS variables (for debugging) */
  appliedVariables: Ref<CSSVariableMap>;
}

export function useTheme(): UseThemeReturn {
  const pack = injectService('gamePack');

  /** Track whether a theme is currently active */
  const isApplied = ref(false);
  /** Track which CSS variables we've set, so clearTheme can remove them */
  const appliedVariables = ref<CSSVariableMap>({});

  /**
   * Apply a theme config to the document root element.
   *
   * Supports two value types:
   * - string  → set directly as a CSS variable
   * - object  → flatten recursively with a prefixed variable name
   * - other   → convert to string if possible (numbers become "42" etc.)
   *
   * String values are mapped as `--color-{kebab-key}` for backward
   * compatibility with color-centric themes. Object values use
   * `--theme-{prefix}-{kebab-key}` to distinguish structural config.
   */
  function applyTheme(theme: Record<string, unknown>): void {
    const root = document.documentElement;
    const variables: CSSVariableMap = {};

    flattenTheme(theme, '', variables);

    for (const [cssVar, value] of Object.entries(variables)) {
      root.style.setProperty(cssVar, value);
    }

    appliedVariables.value = variables;
    isApplied.value = true;
  }

  /**
   * Recursively flatten a theme object into CSS variable entries.
   *
   * Top-level string values:  --color-{kebab-key}
   * Nested object values:     --theme-{parent}-{kebab-key}
   * Non-string leaf values:   converted via String()
   */
  function flattenTheme(
    obj: Record<string, unknown>,
    prefix: string,
    out: CSSVariableMap,
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const kebab = toKebabCase(key);

      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // Recurse into nested objects with a prefix
        const nestedPrefix = prefix ? `${prefix}-${kebab}` : kebab;
        flattenTheme(value as Record<string, unknown>, nestedPrefix, out);
      } else if (value !== undefined && value !== null) {
        // Leaf value — determine the CSS variable name
        const stringValue = String(value);
        if (prefix) {
          // Nested leaf: use --theme- prefix
          out[`--theme-${prefix}-${kebab}`] = stringValue;
        } else {
          // Top-level leaf: use --color- prefix (conventional for color themes)
          out[`--color-${kebab}`] = stringValue;
        }
      }
    }
  }

  /**
   * Convert a camelCase or PascalCase string to kebab-case.
   *
   * Examples:
   *   "primaryColor"   → "primary-color"
   *   "surfaceBg"      → "surface-bg"
   *   "BGColor"        → "b-g-color" (rare edge case, acceptable)
   */
  function toKebabCase(str: string): string {
    return str.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
  }

  /**
   * Remove all CSS variables that were set by this composable.
   * Useful when switching game packs or entering a theme-less mode.
   */
  function clearTheme(): void {
    const root = document.documentElement;
    for (const cssVar of Object.keys(appliedVariables.value)) {
      root.style.removeProperty(cssVar);
    }
    appliedVariables.value = {};
    isApplied.value = false;
  }

  // ─── Lifecycle: apply pack theme on mount ────────────────────

  onMounted(() => {
    if (pack?.theme) {
      applyTheme(pack.theme);
    }
  });

  // ─── Reactivity: re-apply if the pack reference changes ─────
  // This handles hot-reloading scenarios during development.
  // In production the pack rarely changes after initial load.
  watch(
    () => pack?.theme,
    (newTheme) => {
      if (newTheme) {
        clearTheme();
        applyTheme(newTheme);
      }
    },
  );

  return { applyTheme, clearTheme, isApplied, appliedVariables };
}
