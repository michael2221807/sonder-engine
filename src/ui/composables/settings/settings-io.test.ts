// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACCENT_PRESETS, CACHE_PROTECTED_KEYS, applyRootMetrics, collectClearableCacheKeys, defaultSettings, knownSettings, presetSwatches,
} from './settings-io';

/** The loop clearCache() in SettingsPanel.vue ran inline before the move, copied as it stood. */
function legacyKeysToRemove(): string[] {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('aga_') || k.startsWith('aga-')) && !CACHE_PROTECTED_KEYS.has(k)) {
      keysToRemove.push(k);
    }
  }
  return keysToRemove;
}

describe('knownSettings', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const raw of [null, undefined, 0, 'x', true]) expect(knownSettings(raw)).toEqual(defaultSettings);
  });

  it('keeps stored values of known keys over the defaults and drops unknown keys', () => {
    const got = knownSettings({ fontSize: 18, language: 'en', showActionOptions: true, extra: 1 });
    expect(got).toEqual({ ...defaultSettings, fontSize: 18, language: 'en' });
    expect('showActionOptions' in got).toBe(false);
  });

  it('keeps a stored falsy value but ignores undefined', () => {
    expect(knownSettings({ enableAnimations: false, autoSaveInterval: 0, themeAccent: undefined })).toEqual({
      ...defaultSettings, enableAnimations: false, autoSaveInterval: 0,
    });
  });

  it('does not alias the defaults object', () => {
    const got = knownSettings({});
    got.fontSize = 99;
    expect(defaultSettings.fontSize).toBe(14);
  });
});

describe('applyRootMetrics', () => {
  it('writes the root font size and the three custom properties', () => {
    applyRootMetrics(16, 150);
    const style = document.documentElement.style;
    expect(style.fontSize).toBe('24px');
    expect(style.getPropertyValue('--base-font-size')).toBe('16px');
    expect(style.getPropertyValue('--narrative-font-size')).toBe('16px');
    expect(style.getPropertyValue('--ui-scale')).toBe('150%');
  });
});

describe('presetSwatches / ACCENT_PRESETS', () => {
  it('builds oklch swatches from the two hues', () => {
    expect(presetSwatches({ id: 'x', hue1: 150, hue2: 75, labelKey: 'k' })).toEqual({
      primary: 'oklch(0.78 0.08 150)', secondary: 'oklch(0.80 0.09 75)',
    });
  });

  it('lists the ten presets in their order, the first being the default accent', () => {
    expect(ACCENT_PRESETS.map((p) => p.id)).toEqual([
      'sage-amber', 'ocean-coral', 'lavender-gold', 'rose-teal', 'mint-peach',
      'indigo-amber', 'emerald-ruby', 'cyan-magenta', 'copper-slate', 'twilight-dawn',
    ]);
    expect(defaultSettings.themeAccent).toBe(ACCENT_PRESETS[0].id);
  });
});

describe('collectClearableCacheKeys', () => {
  beforeEach(() => localStorage.clear());

  it('selects aga_ and aga- keys except the protected ones, in storage order', () => {
    const keys = ['aga_user_settings', 'aga_scratch', 'aga-draft', 'other', 'aga_nsfw_settings', 'aga_image_cache_x', 'aga_ui_scale'];
    for (const k of keys) localStorage.setItem(k, '1');
    const got = collectClearableCacheKeys();
    expect(got.sort()).toEqual(['aga-draft', 'aga_image_cache_x', 'aga_scratch']);
    expect(collectClearableCacheKeys()).toEqual(legacyKeysToRemove());
  });

  it('is empty when nothing qualifies', () => {
    localStorage.setItem('aga_user_settings', '{}');
    expect(collectClearableCacheKeys()).toEqual([]);
  });

  it('protects every key SettingsPanel and its neighbours keep user config in', () => {
    for (const k of CACHE_PROTECTED_KEYS) localStorage.setItem(k, '1');
    expect(collectClearableCacheKeys()).toEqual([]);
    expect(CACHE_PROTECTED_KEYS.size).toBe(16);
  });
});
