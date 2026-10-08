/**
 * Device-level UI settings (language, font size, accent colour) and the pure helpers around them, moved verbatim
 * out of SettingsPanel.vue (refactor R7 step 9). Nothing here touches component state or registers a hook; the
 * panel keeps every ref, watch and lifecycle call and imports these definitions.
 */

export const SETTINGS_KEY = 'aga_user_settings';

/** User settings shape */
export interface UserSettings {
  fontSize: number;
  themeAccent: string;
  enableAnimations: boolean;
  autoSaveInterval: number;
  language: string;
}

export interface AccentPreset {
  id: string;
  hue1: number;
  hue2: number;
  labelKey: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'sage-amber',      hue1: 150, hue2: 75,  labelKey: 'settings.ui.themeAccent.presets.sage' },
  { id: 'ocean-coral',     hue1: 220, hue2: 15,  labelKey: 'settings.ui.themeAccent.presets.ocean' },
  { id: 'lavender-gold',   hue1: 280, hue2: 55,  labelKey: 'settings.ui.themeAccent.presets.lavender' },
  { id: 'rose-teal',       hue1: 345, hue2: 175, labelKey: 'settings.ui.themeAccent.presets.rose' },
  { id: 'mint-peach',      hue1: 165, hue2: 40,  labelKey: 'settings.ui.themeAccent.presets.mint' },
  { id: 'indigo-amber',    hue1: 255, hue2: 70,  labelKey: 'settings.ui.themeAccent.presets.indigo' },
  { id: 'emerald-ruby',    hue1: 145, hue2: 5,   labelKey: 'settings.ui.themeAccent.presets.emerald' },
  { id: 'cyan-magenta',    hue1: 200, hue2: 330, labelKey: 'settings.ui.themeAccent.presets.cyan' },
  { id: 'copper-slate',    hue1: 35,  hue2: 240, labelKey: 'settings.ui.themeAccent.presets.copper' },
  { id: 'twilight-dawn',   hue1: 290, hue2: 25,  labelKey: 'settings.ui.themeAccent.presets.twilight' },
];

export const defaultSettings: UserSettings = {
  fontSize: 14,
  themeAccent: 'sage-amber',
  enableAnimations: true,
  autoSaveInterval: 5,
  language: 'zh-CN',
};

/**
 * The stored settings this build knows, over the defaults. A key an older build saved (showActionOptions, removed
 * 2026-10-03) is dropped: kept, it would make 「重置全部」 show forever for a player at the defaults.
 */
export function knownSettings(raw: unknown): UserSettings {
  const known: UserSettings = { ...defaultSettings };
  if (!raw || typeof raw !== 'object') return known;
  const stored = raw as Partial<Record<keyof UserSettings, unknown>>;
  for (const key of Object.keys(defaultSettings) as (keyof UserSettings)[]) {
    if (stored[key] !== undefined) (known as Record<keyof UserSettings, unknown>)[key] = stored[key];
  }
  return known;
}

// Font size × UI scale both drive the root font-size so rem units scale
// consistently. The `--narrative-font-size` var stays in sync for narrative
// text that explicitly opts in.
export function applyRootMetrics(fontPx: number, scalePct: number): void {
  const rootPx = (fontPx * scalePct) / 100;
  document.documentElement.style.fontSize = `${rootPx}px`;
  document.documentElement.style.setProperty('--base-font-size', `${fontPx}px`);
  document.documentElement.style.setProperty('--narrative-font-size', `${fontPx}px`);
  document.documentElement.style.setProperty('--ui-scale', `${scalePct}%`);
}

export function presetSwatches(preset: AccentPreset): { primary: string; secondary: string } {
  return {
    primary: `oklch(0.78 0.08 ${preset.hue1})`,
    secondary: `oklch(0.80 0.09 ${preset.hue2})`,
  };
}

/** Keys that must never be cleared by "clear cache" — they hold user config, not transient caches */
export const CACHE_PROTECTED_KEYS = new Set([
  'aga_api_management',
  'aga_ai_settings',
  'aga_engram_config',
  'aga_user_settings',
  'aga_action_options_settings',
  'aga_debug_settings',
  'aga_text_replace_rules',
  'aga_autosave_settings',
  'aga_feature_toggles',
  'aga_memory_settings',
  'aga_nsfw_settings',
  'aga_plot_settings',
  'aga_heartbeat_settings',
  'aga_assistant_settings',
  'aga_ui_scale',
  'aga_text_speed',
]);

/** The localStorage keys "clear cache" removes: every `aga_` / `aga-` key that is not protected. */
export function collectClearableCacheKeys(): string[] {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('aga_') || k.startsWith('aga-')) && !CACHE_PROTECTED_KEYS.has(k)) {
      keysToRemove.push(k);
    }
  }
  return keysToRemove;
}
