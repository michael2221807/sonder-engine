import { describe, it, expect } from 'vitest';
import { wordCountOf, wordCountRangeOf, WORD_COUNT_BAND } from './world-book';

// PO 2026-10-03 (2B): the word count is a target with a band around it, not a minimum.
describe('wordCountRangeOf', () => {
  it('a fifth either way, rounded to tens', () => {
    expect(WORD_COUNT_BAND).toBe(0.2);
    expect(wordCountRangeOf({ wordCountRequirement: 2500 })).toEqual({ target: 2500, min: 2000, max: 3000 });
    expect(wordCountRangeOf({ wordCountRequirement: 650 })).toEqual({ target: 650, min: 520, max: 780 });
    expect(wordCountRangeOf({ wordCountRequirement: 1234 })).toEqual({ target: 1234, min: 990, max: 1480 });
  });
  it('the band never ends on the wrong side of a small target', () => {
    for (const target of [1, 4, 5, 9, 12, 15]) {
      const { min, max } = wordCountRangeOf({ wordCountRequirement: target });
      expect(min).toBeGreaterThanOrEqual(1);
      expect(min).toBeLessThanOrEqual(target);
      expect(max).toBeGreaterThanOrEqual(target);
    }
  });
  it('an unusable setting falls back to the default target', () => {
    for (const value of [undefined, null, 0, -3, 0.4, 'abc']) {
      expect(wordCountOf({ wordCountRequirement: value as never })).toBe(650);
      expect(wordCountRangeOf({ wordCountRequirement: value as never }).target).toBe(650);
    }
    expect(wordCountRangeOf(undefined)).toEqual({ target: 650, min: 520, max: 780 });
  });
});
