import { describe, it, expect } from 'vitest';
import { formatSizeBytes, formatSizeKB } from './format-size';

describe('save size for display (存档瘦身 D9A)', () => {
  it('shows whole KB under 1 MB and MB with one decimal from there on', () => {
    expect(formatSizeKB(0)).toBe('0 KB');
    expect(formatSizeKB(640.4)).toBe('640 KB');
    expect(formatSizeKB(1023.4)).toBe('1023 KB');
    expect(formatSizeKB(1023.6)).toBe('1.0 MB');
    expect(formatSizeKB(8806)).toBe('8.6 MB');
    expect(formatSizeKB(31252)).toBe('30.5 MB');
  });

  it('shows a dash for no size or one that is not a size', () => {
    for (const value of [undefined, null, NaN, -1, Infinity]) expect(formatSizeKB(value)).toBe('—');
    expect(formatSizeBytes(undefined)).toBe('—');
  });

  it('takes bytes for a local save', () => {
    expect(formatSizeBytes(512)).toBe('1 KB');
    expect(formatSizeBytes(9_123_456)).toBe('8.7 MB');
  });
});
