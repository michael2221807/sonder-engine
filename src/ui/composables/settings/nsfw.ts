/**
 * NSFW device settings definitions and the stored-value parser, moved out of SettingsPanel.vue (refactor R7 step 9).
 * The panel keeps the ref, the state-tree sync and the watchers.
 */

export const NSFW_KEY = 'aga_nsfw_settings';
export type NsfwGenderFilter = 'all' | 'male' | 'female';

export interface NsfwSettings {
  nsfwMode: boolean;
  nsfwGenderFilter: NsfwGenderFilter;
}

export const defaultNsfw: NsfwSettings = {
  nsfwMode: false,
  nsfwGenderFilter: 'female',
};

/** The settings in a stored JSON text; throws when the text is not JSON (the caller's try/catch falls back). */
export function parseNsfwSettings(raw: string): NsfwSettings {
  const parsed = JSON.parse(raw) as Partial<NsfwSettings>;
  return {
    nsfwMode: typeof parsed.nsfwMode === 'boolean' ? parsed.nsfwMode : defaultNsfw.nsfwMode,
    nsfwGenderFilter:
      parsed.nsfwGenderFilter === 'all' ||
      parsed.nsfwGenderFilter === 'male' ||
      parsed.nsfwGenderFilter === 'female'
        ? parsed.nsfwGenderFilter
        : defaultNsfw.nsfwGenderFilter,
  };
}
