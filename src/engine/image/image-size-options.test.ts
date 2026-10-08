import { describe, it, expect } from 'vitest';
import {
  COMMON_SIZE_OPTIONS,
  SCENE_PORTRAIT_SIZE_OPTIONS,
  SCENE_LANDSCAPE_SIZE_OPTIONS,
  parseSizeString,
  sizeOptionsToSelectOptions,
} from './image-size-options';

describe('image-size-options', () => {
  describe('COMMON_SIZE_OPTIONS', () => {
    it('has 7 presets', () => {
      expect(COMMON_SIZE_OPTIONS).toHaveLength(7);
    });

    it('each option has required fields', () => {
      for (const opt of COMMON_SIZE_OPTIONS) {
        expect(opt.value).toMatch(/^\d+x\d+$/);
        expect(opt.label).toContain(opt.value);
        expect(opt.width).toBeGreaterThan(0);
        expect(opt.height).toBeGreaterThan(0);
        expect(['square', 'portrait', 'landscape']).toContain(opt.orientation);
      }
    });

    it('includes 1024x1024 SDXL', () => {
      expect(COMMON_SIZE_OPTIONS.some((o) => o.value === '1024x1024')).toBe(true);
    });
  });

  describe('SCENE_PORTRAIT_SIZE_OPTIONS', () => {
    it('has 9 presets', () => {
      expect(SCENE_PORTRAIT_SIZE_OPTIONS).toHaveLength(9);
    });

    it('starts with 576x1024', () => {
      expect(SCENE_PORTRAIT_SIZE_OPTIONS[0].value).toBe('576x1024');
    });

    it('all have height >= width (portrait orientation)', () => {
      for (const opt of SCENE_PORTRAIT_SIZE_OPTIONS) {
        if (opt.orientation !== 'square') {
          expect(opt.height).toBeGreaterThanOrEqual(opt.width);
        }
      }
    });
  });

  describe('SCENE_LANDSCAPE_SIZE_OPTIONS', () => {
    it('has 10 presets', () => {
      expect(SCENE_LANDSCAPE_SIZE_OPTIONS).toHaveLength(10);
    });

    it('starts with 1024x576', () => {
      expect(SCENE_LANDSCAPE_SIZE_OPTIONS[0].value).toBe('1024x576');
    });

    it('all have width >= height (landscape orientation)', () => {
      for (const opt of SCENE_LANDSCAPE_SIZE_OPTIONS) {
        if (opt.orientation !== 'square') {
          expect(opt.width).toBeGreaterThanOrEqual(opt.height);
        }
      }
    });
  });

  describe('parseSizeString', () => {
    it('parses "1024x576"', () => {
      expect(parseSizeString('1024x576')).toEqual({ width: 1024, height: 576 });
    });

    it('parses "832×1216" (fullwidth ×)', () => {
      expect(parseSizeString('832×1216')).toEqual({ width: 832, height: 1216 });
    });

    it('parses with spaces "1024 x 576"', () => {
      expect(parseSizeString('1024 x 576')).toEqual({ width: 1024, height: 576 });
    });

    it('returns null for invalid format', () => {
      expect(parseSizeString('abc')).toBeNull();
      expect(parseSizeString('1024')).toBeNull();
      expect(parseSizeString('')).toBeNull();
      expect(parseSizeString('0x0')).toBeNull();
    });
  });

  describe('sizeOptionsToSelectOptions', () => {
    it('converts to { label, value } format', () => {
      const result = sizeOptionsToSelectOptions(COMMON_SIZE_OPTIONS.slice(0, 2));
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('label');
      expect(result[0]).toHaveProperty('value');
      expect(result[0].value).toBe('512x512');
    });
  });

  describe('no duplicates', () => {
    it('portrait options have unique values', () => {
      const values = SCENE_PORTRAIT_SIZE_OPTIONS.map((o) => o.value);
      expect(new Set(values).size).toBe(values.length);
    });

    it('landscape options have unique values', () => {
      const values = SCENE_LANDSCAPE_SIZE_OPTIONS.map((o) => o.value);
      expect(new Set(values).size).toBe(values.length);
    });
  });
});
