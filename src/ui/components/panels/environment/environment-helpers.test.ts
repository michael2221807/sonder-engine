import { describe, it, expect } from 'vitest';
import {
  isValidTag,
  formatTagSummary,
  countOverflow,
  sanitizeTagList,
  isFestivalVisible,
  normalizeFestival,
  normalizeWeather,
} from '@/ui/components/panels/environment/environment-helpers';

describe('isValidTag', () => {
  it('accepts complete tag', () => {
    expect(isValidTag({ 名称: 'A', 描述: 'B', 效果: 'C' })).toBe(true);
  });
  it('accepts empty 描述 + 效果 strings', () => {
    expect(isValidTag({ 名称: 'A', 描述: '', 效果: '' })).toBe(true);
  });
  it('rejects empty 名称', () => {
    expect(isValidTag({ 名称: '', 描述: 'B', 效果: 'C' })).toBe(false);
  });
  it('rejects whitespace-only 名称', () => {
    expect(isValidTag({ 名称: '   ', 描述: 'B', 效果: 'C' })).toBe(false);
  });
  it('rejects missing 描述', () => {
    expect(isValidTag({ 名称: 'A', 效果: 'C' })).toBe(false);
  });
  it('rejects null', () => {
    expect(isValidTag(null)).toBe(false);
  });
  it('rejects non-object', () => {
    expect(isValidTag('not-a-tag')).toBe(false);
    expect(isValidTag(42)).toBe(false);
  });
});

describe('formatTagSummary', () => {
  it('empty input → empty string', () => {
    expect(formatTagSummary([])).toBe('');
    expect(formatTagSummary(null)).toBe('');
    expect(formatTagSummary(undefined)).toBe('');
  });

  it('single tag', () => {
    expect(formatTagSummary([{ 名称: '污秽', 描述: '', 效果: '' }])).toBe('污秽');
  });

  it('multiple tags joined with 、', () => {
    const tags = [
      { 名称: 'A', 描述: '', 效果: '' },
      { 名称: 'B', 描述: '', 效果: '' },
      { 名称: 'C', 描述: '', 效果: '' },
    ];
    expect(formatTagSummary(tags)).toBe('A、B、C');
  });

  it('overflow beyond cap shows …+N', () => {
    const tags = [
      { 名称: 'A', 描述: '', 效果: '' },
      { 名称: 'B', 描述: '', 效果: '' },
      { 名称: 'C', 描述: '', 效果: '' },
      { 名称: 'D', 描述: '', 效果: '' },
      { 名称: 'E', 描述: '', 效果: '' },
    ];
    expect(formatTagSummary(tags, 3)).toBe('A、B、C…+2');
  });

  it('exact cap → no overflow suffix', () => {
    const tags = [
      { 名称: 'A', 描述: '', 效果: '' },
      { 名称: 'B', 描述: '', 效果: '' },
      { 名称: 'C', 描述: '', 效果: '' },
    ];
    expect(formatTagSummary(tags, 3)).toBe('A、B、C');
  });

  it('skips malformed tags silently', () => {
    const tags = [
      { 名称: 'A', 描述: '', 效果: '' },
      { 名称: '', 描述: 'bad', 效果: 'bad' }, // empty name
      { 名称: 'B', 描述: '', 效果: '' },
      null,
      { notATag: true },
    ] as unknown[];
    expect(formatTagSummary(tags)).toBe('A、B');
  });

  it('trims whitespace from names', () => {
    expect(formatTagSummary([{ 名称: '  污秽  ', 描述: '', 效果: '' }])).toBe('污秽');
  });
});

describe('countOverflow', () => {
  it('returns 0 when below cap', () => {
    expect(countOverflow([{ 名称: 'A', 描述: '', 效果: '' }], 3)).toBe(0);
  });

  it('returns excess count above cap', () => {
    const tags = Array.from({ length: 7 }, (_, i) => ({
      名称: `T${i}`,
      描述: '',
      效果: '',
    }));
    expect(countOverflow(tags, 3)).toBe(4);
  });

  it('returns 0 on malformed input', () => {
    expect(countOverflow(null, 3)).toBe(0);
  });

  it('returns full valid count when cap=0', () => {
    const tags = [
      { 名称: 'A', 描述: '', 效果: '' },
      { 名称: 'B', 描述: '', 效果: '' },
      { 名称: 'C', 描述: '', 效果: '' },
    ];
    expect(countOverflow(tags, 0)).toBe(3);
  });
});

describe('sanitizeTagList', () => {
  it('drops invalid entries', () => {
    const raw = [
      { 名称: 'A', 描述: 'd1', 效果: 'e1' },
      { 名称: '', 描述: 'bad', 效果: 'bad' },
      null,
      { 名称: 'B', 描述: 'd2', 效果: 'e2' },
    ];
    expect(sanitizeTagList(raw)).toHaveLength(2);
  });

  it('returns [] on non-array', () => {
    expect(sanitizeTagList('not-array')).toEqual([]);
    expect(sanitizeTagList(null)).toEqual([]);
  });
});

describe('isFestivalVisible', () => {
  it('hides default 平日', () => {
    expect(isFestivalVisible({ 名称: '平日', 描述: '', 效果: '' })).toBe(false);
  });

  it('shows named festival (元宵节)', () => {
    expect(isFestivalVisible({ 名称: '元宵节', 描述: '', 效果: '' })).toBe(true);
  });

  it('shows 平日 with custom description', () => {
    expect(isFestivalVisible({ 名称: '平日', 描述: '今日闲逛', 效果: '' })).toBe(true);
  });

  it('shows 平日 with custom effect', () => {
    expect(isFestivalVisible({ 名称: '平日', 描述: '', 效果: '+1心情' })).toBe(true);
  });

  it('hides on empty name', () => {
    expect(isFestivalVisible({ 名称: '', 描述: 'x', 效果: 'y' })).toBe(false);
  });

  it('hides on whitespace-only name', () => {
    expect(isFestivalVisible({ 名称: '   ', 描述: 'x', 效果: 'y' })).toBe(false);
  });

  it('hides on null / non-object', () => {
    expect(isFestivalVisible(null)).toBe(false);
    expect(isFestivalVisible(undefined)).toBe(false);
    expect(isFestivalVisible('not-object')).toBe(false);
  });
});

describe('normalizeFestival', () => {
  it('returns full tag when valid', () => {
    expect(normalizeFestival({ 名称: '元宵节', 描述: 'd', 效果: 'e' })).toEqual({
      名称: '元宵节',
      描述: 'd',
      效果: 'e',
    });
  });

  it('returns null for empty name', () => {
    expect(normalizeFestival({ 名称: '', 描述: '', 效果: '' })).toBeNull();
  });

  it('fills empty strings for missing 描述/效果 fields', () => {
    expect(normalizeFestival({ 名称: '节日' })).toEqual({
      名称: '节日',
      描述: '',
      效果: '',
    });
  });

  it('trims all three fields', () => {
    expect(normalizeFestival({ 名称: '  节日  ', 描述: '  d  ', 效果: '  e  ' })).toEqual({
      名称: '节日',
      描述: 'd',
      效果: 'e',
    });
  });

  it('returns null on null input', () => {
    expect(normalizeFestival(null)).toBeNull();
  });
});

describe('normalizeWeather', () => {
  it('returns trimmed string when valid', () => {
    expect(normalizeWeather('  暴雨  ')).toBe('暴雨');
  });

  it('falls back to 晴 on empty string', () => {
    expect(normalizeWeather('')).toBe('晴');
  });

  it('falls back to 晴 on non-string', () => {
    expect(normalizeWeather(null)).toBe('晴');
    expect(normalizeWeather(undefined)).toBe('晴');
    expect(normalizeWeather(42)).toBe('晴');
  });
});
