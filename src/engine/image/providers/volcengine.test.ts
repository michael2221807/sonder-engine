import { describe, it, expect } from 'vitest';
import { resolveSeedreamSize } from './volcengine';

// NOTE: these ranges mirror the official docs as of 2026-08 and are pinned so
// future tweaks are deliberate; the real-key calibration matrix (P1 acceptance)
// is the authority if they disagree.
describe('resolveSeedreamSize', () => {
  const parse = (s: string) => s.split('x').map(Number) as [number, number];

  it('seedream-4.x: scales small requests up into [1280, 4096]', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', 1024, 1024));
    expect(w).toBe(1280);
    expect(h).toBe(1280);
  });

  it('seedream-4.x: keeps aspect ratio for portrait requests', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', 832, 1216));
    expect(w).toBe(1280);                       // min side raised to floor
    expect(h / w).toBeCloseTo(1216 / 832, 1);   // ratio preserved (±rounding)
    expect(h).toBeLessThanOrEqual(4096);
  });

  it('seedream-3.x: 1024 passes through unscaled inside [512, 2048]', () => {
    expect(resolveSeedreamSize('doubao-seedream-3-0-t2i-250415', 1024, 1024)).toBe('1024x1024');
  });

  it('oversized requests scale down to the max bound', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-3-0-t2i-250415', 8192, 4096));
    expect(w).toBe(2048);
    expect(h).toBeGreaterThanOrEqual(512);      // clamped floor even at extreme ratios
    expect(h).toBeLessThanOrEqual(2048);
  });

  it('extreme aspect ratios stay within bounds (down-scale wins, floor clamps)', () => {
    const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', 100, 4000));
    expect(w).toBeGreaterThanOrEqual(1280);
    expect(w).toBeLessThanOrEqual(4096);
    expect(h).toBeGreaterThanOrEqual(1280);
    expect(h).toBeLessThanOrEqual(4096);
  });

  it('every output side is a multiple of 8', () => {
    for (const [rw, rh] of [[1024, 1024], [832, 1216], [1920, 1080], [500, 700]] as const) {
      const [w, h] = parse(resolveSeedreamSize('doubao-seedream-4-0-250828', rw, rh));
      expect(w % 8).toBe(0);
      expect(h % 8).toBe(0);
    }
  });

  it('unknown model uses the conservative [512, 4096] range without upscaling above floor', () => {
    expect(resolveSeedreamSize('some-future-model', 1024, 1024)).toBe('1024x1024');
  });

  it('non-finite / non-positive inputs fall back to a square instead of NaNxNaN', () => {
    expect(resolveSeedreamSize('doubao-seedream-4-0-250828', NaN, Infinity)).toBe('1280x1280');
    expect(resolveSeedreamSize('doubao-seedream-3-0-t2i-250415', 0, -5)).toBe('1024x1024');
  });
});
