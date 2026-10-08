import { describe, expect, it } from 'vitest';
import {
  CUSTOM_PRESETS_SUPPORTED_VERSION, buildCustomPresetsExport, cleanImportedPresets, countCustomPresets, customPresetsFileName,
  isUnsupportedPresetsVersion,
} from './custom-presets-io';

/** The import loop inside importCustomPresets() in SavePanel.vue before the move, copied as it stood. */
function legacyClean(presets: Record<string, unknown[]> | undefined): Record<string, Record<string, unknown>[]> {
  const presetsByType: Record<string, Record<string, unknown>[]> = {};
  for (const [presetType, list] of Object.entries(presets ?? {})) {
    if (!Array.isArray(list)) continue;
    const cleaned: Record<string, unknown>[] = [];
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      cleaned.push(raw as Record<string, unknown>);
    }
    if (cleaned.length > 0) presetsByType[presetType] = cleaned;
  }
  return presetsByType;
}

/** The count inside exportCustomPresets() before the move, copied as it stood. */
function legacyCount(presets: Record<string, unknown[]> | undefined): number {
  return Object.values(presets ?? {}).reduce(
    (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
    0,
  );
}

const CORPUS: Array<Record<string, unknown[]> | undefined> = [
  undefined,
  {},
  { worlds: [] },
  { worlds: [{ id: 'user_1' }, { id: 'user_2' }], origins: [{ id: 'user_3' }] },
  { worlds: [null, 3, 'x', { id: 'ok' }, [], undefined] },
  { worlds: 'oops' as unknown as unknown[], traits: [{ id: 't' }] },
  { a: [1, 2, 3] },
];

describe('countCustomPresets', () => {
  it('counts the entries of every array and ignores non-arrays', () => {
    expect(countCustomPresets(undefined)).toBe(0);
    expect(countCustomPresets({ worlds: [{}, {}], origins: [{}] })).toBe(3);
    expect(countCustomPresets({ worlds: 'oops' as unknown as unknown[] })).toBe(0);
  });

  it('agrees with the inline code on a corpus', () => {
    for (const c of CORPUS) expect(countCustomPresets(c)).toBe(legacyCount(c));
  });
});

describe('buildCustomPresetsExport / customPresetsFileName', () => {
  it('builds the version 1 custom_presets file with the keys in the order they were always written', () => {
    const file = buildCustomPresetsExport('tianming', { worlds: [{ id: 'u1' }] }, '2026-10-08T00:00:00.000Z');
    expect(file).toEqual({
      version: 1, type: 'custom_presets', packId: 'tianming', exportedAt: '2026-10-08T00:00:00.000Z', presets: { worlds: [{ id: 'u1' }] },
    });
    expect(Object.keys(file)).toEqual(['version', 'type', 'packId', 'exportedAt', 'presets']);
    expect(JSON.stringify(file, null, 2)).toContain('"type": "custom_presets"');
  });

  it('uses an empty map when the store has no presets', () => {
    expect(buildCustomPresetsExport('p', undefined, 't').presets).toEqual({});
  });

  it('names the file presets-<pack>-<date>.json', () => {
    expect(customPresetsFileName('tianming', '2026-10-08')).toBe('presets-tianming-2026-10-08.json');
  });
});

describe('isUnsupportedPresetsVersion', () => {
  it('accepts numbers up to the supported version and rejects newer or non-numbers', () => {
    expect(CUSTOM_PRESETS_SUPPORTED_VERSION).toBe(1);
    expect(isUnsupportedPresetsVersion(1)).toBe(false);
    expect(isUnsupportedPresetsVersion(0)).toBe(false);
    expect(isUnsupportedPresetsVersion(2)).toBe(true);
    expect(isUnsupportedPresetsVersion('1')).toBe(true);
    expect(isUnsupportedPresetsVersion(undefined)).toBe(true);
    expect(isUnsupportedPresetsVersion(NaN)).toBe(false);
  });
});

describe('cleanImportedPresets', () => {
  it('keeps object entries, drops other values and types left empty', () => {
    expect(cleanImportedPresets({ worlds: [null, 3, { id: 'ok' }], origins: [], traits: ['x'] })).toEqual({ worlds: [{ id: 'ok' }] });
    expect(cleanImportedPresets(undefined)).toEqual({});
  });

  it('keeps arrays inside the list as entries (typeof array is object), as the inline loop did', () => {
    expect(cleanImportedPresets({ a: [[1], { b: 1 }] })).toEqual({ a: [[1], { b: 1 }] });
  });

  it('agrees with the inline loop on a corpus', () => {
    for (const c of CORPUS) expect(cleanImportedPresets(c)).toEqual(legacyClean(c));
  });
});
