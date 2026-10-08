import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES, isSupportedLocale } from '../index';
import zhCN from '../locales/zh-CN/index';
import en from '../locales/en/index';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...flattenKeys(v as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

describe('i18n infrastructure', () => {
  it('SUPPORTED_LOCALES contains zh-CN and en', () => {
    expect(SUPPORTED_LOCALES).toContain('zh-CN');
    expect(SUPPORTED_LOCALES).toContain('en');
  });

  it('isSupportedLocale accepts valid locales', () => {
    expect(isSupportedLocale('zh-CN')).toBe(true);
    expect(isSupportedLocale('en')).toBe(true);
  });

  it('isSupportedLocale rejects invalid locales', () => {
    expect(isSupportedLocale('zh-TW')).toBe(false);
    expect(isSupportedLocale('ja')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
    expect(isSupportedLocale('EN')).toBe(false);
  });
});

describe('locale key parity (zh-CN ↔ en)', () => {
  const zhKeys = new Set(flattenKeys(zhCN));
  const enKeys = new Set(flattenKeys(en));

  it('en has all keys that zh-CN has', () => {
    const missingInEn = [...zhKeys].filter(k => !enKeys.has(k));
    expect(missingInEn).toEqual([]);
  });

  it('zh-CN has all keys that en has', () => {
    const extraInEn = [...enKeys].filter(k => !zhKeys.has(k));
    expect(extraInEn).toEqual([]);
  });

  it('key counts match', () => {
    expect(enKeys.size).toBe(zhKeys.size);
  });
});

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let val: unknown = obj;
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return undefined;
    val = (val as Record<string, unknown>)[p];
  }
  return val;
}

describe('locale values are non-empty', () => {
  it('zh-CN has no empty string values', () => {
    const zhFlat = flattenKeys(zhCN);
    const emptyKeys = zhFlat.filter(k => getNestedValue(zhCN, k) === '');
    expect(emptyKeys, `zh-CN empty keys: ${emptyKeys.join(', ')}`).toEqual([]);
  });

  it('en has no empty string values', () => {
    const enFlat = flattenKeys(en);
    const emptyKeys = enFlat.filter(k => getNestedValue(en, k) === '');
    expect(emptyKeys, `en empty keys: ${emptyKeys.join(', ')}`).toEqual([]);
  });
});
describe('locale files do not define the same key twice', () => {
  // index.ts spreads the 24 JSON files in order, so a duplicate key is silently overridden
  // by the later file (X03-002: debug.json vs inventory.json). Keep every key in one file.
  for (const locale of ['zh-CN', 'en']) {
    it(`${locale}: no key is defined in more than one JSON file`, () => {
      const dir = resolve(__dirname, '../locales', locale);
      const owners = new Map<string, string[]>();
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const json = JSON.parse(readFileSync(resolve(dir, file), 'utf8')) as Record<string, unknown>;
        for (const key of flattenKeys(json)) owners.set(key, [...(owners.get(key) ?? []), file]);
      }
      const dupes = [...owners].filter(([, files]) => files.length > 1).map(([key, files]) => `${key} (${files.join(', ')})`);
      expect(dupes).toEqual([]);
    });
  }
});
