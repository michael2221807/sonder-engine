import { describe, expect, it } from 'vitest';
import {
  getCreationGenre,
  isChoicePresetVisible,
  isWorldPresetVisible,
  retainVisiblePresetSelection,
  samePresetEntry,
} from './preset-policy';

describe('creation preset visibility policy', () => {
  it('hides only explicitly NSFW worlds when the setting is off', () => {
    expect(isWorldPresetVisible({ contentRating: 'general' }, false)).toBe(true);
    expect(isWorldPresetVisible({ contentRating: 'nsfw' }, false)).toBe(false);
    expect(isWorldPresetVisible({}, false)).toBe(true);
    expect(isWorldPresetVisible({ contentRating: 'nsfw' }, true)).toBe(true);
  });

  it('combines selected genre and adult visibility without coupling to world rating', () => {
    const modernAdult = { genres: ['modern'], adultOnly: true };
    expect(isChoicePresetVisible(modernAdult, 'modern', false)).toBe(false);
    expect(isChoicePresetVisible(modernAdult, 'modern', true)).toBe(true);
    expect(isChoicePresetVisible(modernAdult, 'wuxia', true)).toBe(false);
    expect(isChoicePresetVisible({ genres: ['all'] }, 'dystopia', false)).toBe(true);
  });

  it('keeps legacy entries with missing genre metadata visible', () => {
    expect(isChoicePresetVisible({ name: 'legacy' }, 'fantasy', false)).toBe(true);
  });

  it('accepts only supported world genres', () => {
    expect(getCreationGenre({ genre: 'modern' })).toBe('modern');
    expect(getCreationGenre({ genre: 'cultivation' })).toBeNull();
    expect(getCreationGenre(null)).toBeNull();
  });

  it('matches entries by stable id or name for selection cleanup', () => {
    expect(samePresetEntry({ id: 1, name: 'old' }, { id: 1, name: 'new' })).toBe(true);
    expect(samePresetEntry({ name: 'same' }, { name: 'same' })).toBe(true);
    expect(samePresetEntry({ id: 'a' }, { id: 'b' })).toBe(false);
  });

  it('keeps compatible selections and removes choices hidden by a world change', () => {
    const visible = [{ id: 'shared' }, { id: 'fantasy-only' }];
    expect(retainVisiblePresetSelection({ id: 'modern-only' }, visible)).toBeUndefined();
    expect(retainVisiblePresetSelection(
      [{ id: 'shared' }, { id: 'modern-only' }],
      visible,
    )).toEqual([{ id: 'shared' }]);
  });

  it('supports a newly added ninth world through metadata alone', () => {
    const ninthWorld = { id: 'world-9', genre: 'fantasy', contentRating: 'general' };
    const genre = getCreationGenre(ninthWorld);
    expect(isWorldPresetVisible(ninthWorld, false)).toBe(true);
    expect(isChoicePresetVisible({ genres: ['fantasy'] }, genre, false)).toBe(true);
    expect(isChoicePresetVisible({ genres: ['modern'] }, genre, false)).toBe(false);
  });
});
