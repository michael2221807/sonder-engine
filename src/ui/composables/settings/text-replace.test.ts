import { describe, expect, it } from 'vitest';
import { emptyRuleForm, filterImportedRules, parseTextRules, type TextReplaceRule } from './text-replace';

/** The import filter inside openImportSettings() in SettingsPanel.vue before the move, copied as it stood. */
function legacyFilter(items: unknown[]): TextReplaceRule[] {
  return items.filter(
    (item): item is TextReplaceRule =>
      typeof (item as TextReplaceRule).id === 'string' &&
      typeof (item as TextReplaceRule).pattern === 'string' &&
      typeof (item as TextReplaceRule).replacement === 'string',
  );
}

const rule = (extra: Partial<TextReplaceRule> = {}): TextReplaceRule => ({
  id: 'r1', enabled: true, mode: 'text', pattern: 'a', replacement: 'b', ignoreCase: false, global: true, ...extra,
});

describe('parseTextRules', () => {
  it('returns the stored array as is and an empty list for anything else', () => {
    expect(parseTextRules(JSON.stringify([rule()]))).toEqual([rule()]);
    expect(parseTextRules('{}')).toEqual([]);
    expect(parseTextRules('"x"')).toEqual([]);
    expect(parseTextRules('null')).toEqual([]);
    expect(parseTextRules('[]')).toEqual([]);
  });

  it('does not validate the entries (the load path never did)', () => {
    expect(parseTextRules('[1,"x",null]')).toEqual([1, 'x', null]);
  });

  it('throws on text that is not JSON (the caller falls back to an empty list)', () => {
    expect(() => parseTextRules('')).toThrow();
    expect(() => parseTextRules('[')).toThrow();
  });
});

describe('emptyRuleForm', () => {
  it('is the form of a new text rule and a fresh object each call', () => {
    expect(emptyRuleForm()).toEqual({ enabled: true, mode: 'text', pattern: '', replacement: '', ignoreCase: false, global: true });
    expect(emptyRuleForm()).not.toBe(emptyRuleForm());
  });
});

describe('filterImportedRules', () => {
  it('keeps only entries with a string id, pattern and replacement', () => {
    const items: unknown[] = [rule(), { id: 'x', pattern: 'p' }, { id: 1, pattern: 'p', replacement: 'r' }, { pattern: 'p', replacement: '' }, rule({ id: 'r2', replacement: '' })];
    expect(filterImportedRules(items)).toEqual([rule(), rule({ id: 'r2', replacement: '' })]);
    expect(filterImportedRules(items)).toEqual(legacyFilter(items));
  });

  it('throws on a null entry exactly as the inline filter did', () => {
    expect(() => filterImportedRules([null])).toThrow();
    expect(() => legacyFilter([null])).toThrow();
  });
});
