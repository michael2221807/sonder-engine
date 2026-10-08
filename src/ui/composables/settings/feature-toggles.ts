/**
 * Feature toggles, chain-of-thought, presence, body polish, low-load and image-generation settings:
 * definitions and the pure read/merge helpers, moved out of SettingsPanel.vue (refactor R7 step 9).
 * The panel keeps the refs, the watchers, the state-tree writes and the lifecycle calls.
 */

export const FEATURE_TOGGLES_KEY = 'aga_feature_toggles';

export interface FeatureToggles {
  text_optimization: boolean;
  world_heartbeat: boolean;
  location_npc_generation: boolean;
  npc_chat: boolean;
  field_repair: boolean;
  plot_decompose: boolean;
  assistant: boolean;
  cot: boolean;
  bodyPolish: boolean;
  imageGeneration: boolean;
  privacy_repair: boolean;
}

export const defaultFeatureToggles: FeatureToggles = {
  text_optimization: false,
  world_heartbeat: true,
  location_npc_generation: true,
  npc_chat: true,
  field_repair: true,
  plot_decompose: true,
  assistant: true,
  cot: false,
  bodyPolish: false,
  imageGeneration: false,
  privacy_repair: true,
};

export const COT_LS_KEY = 'aga_cot_settings';
export const BODY_POLISH_LS_KEY = 'aga_body_polish_settings';
export const PRESENCE_LS_KEY = 'aga_presence_settings';
export const IMAGE_GEN_LS_KEY = 'aga_image_gen_settings';

/** The toggles in a stored JSON text over the defaults; throws when the text is not JSON. */
export function parseFeatureToggles(text: string): FeatureToggles {
  const raw = JSON.parse(text) as Partial<FeatureToggles>;
  return { ...defaultFeatureToggles, ...raw };
}

/**
 * The text to store for the toggles: this panel's toggles over what is on disk now.
 * Read-merge: `aga_feature_toggles` is co-owned with APIPanel, which writes
 * panel-exclusive usageType keys (imageGen_*, world_builder, engram_batch_solidify,
 * card_edge_classify, image*Tokenizer …). This panel's ref is loaded once on mount
 * and (under <KeepAlive>) never refreshed, so a plain overwrite with this panel's
 * stale, narrow shape would erase any key APIPanel added afterward. Merge over the
 * current on-disk value to preserve foreign keys.
 */
export function mergeFeatureTogglesForSave(existingText: string, toggles: FeatureToggles): string {
  const existing = JSON.parse(existingText) as Record<string, unknown>;
  return JSON.stringify({ ...existing, ...toggles });
}

export interface CotSettings {
  enabled: boolean;
  judgeEnabled: boolean;
  injectStep2: boolean;
  ringSize: number;
}

/** The chain-of-thought settings as the game state tree holds them. */
export function readCotSettings(get: (path: string) => unknown): CotSettings {
  return {
    enabled: get('系统.设置.cot.enabled') === true,
    judgeEnabled: get('系统.设置.cot.judgeEnabled') === true,
    injectStep2: get('系统.设置.cot.injectStep2') !== false,
    ringSize: typeof get('系统.设置.cot.reasoningRingSize') === 'number'
      ? (get('系统.设置.cot.reasoningRingSize') as number)
      : 3,
  };
}

/** The reasoning ring size typed into the field, kept in 1-10 (3 when it is not a number). */
export function clampCotRingSize(val: string): number {
  return Math.min(10, Math.max(1, parseInt(val) || 3));
}

/** The low-load fields in the stored AI settings JSON; `maxRequests` is undefined when the stored one is not a number. */
export function parseLowLoadSettings(raw: string): { enabled: boolean; maxRequests: number | undefined } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    enabled: parsed.lowLoadMode === true,
    maxRequests: typeof parsed.lowLoadMaxRequests === 'number'
      ? Math.max(1, Math.min(10, parsed.lowLoadMaxRequests))
      : undefined,
  };
}

/** The low-load request cap typed into the field when it is a whole number in 1-10, otherwise null. */
export function lowLoadMaxRequestsFromInput(val: string): number | null {
  const n = parseInt(val, 10);
  return isFinite(n) && n >= 1 && n <= 10 ? n : null;
}
