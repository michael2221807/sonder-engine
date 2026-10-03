import { describe, expect, it } from 'vitest';
import { RING_ORDER, ringGeometry, type CellBox } from './ring-geometry';

const overlap = (a: CellBox, b: CellBox) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

describe('ring board geometry', () => {
  for (const width of [936, 362]) {
    it(`at ${width}px the six cells fit, never overlap, and go round clockwise`, () => {
      const g = ringGeometry(width);
      const boxes = RING_ORDER.map(id => g.cells[id]);
      for (const box of boxes) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(width);
        expect(box.top + box.height).toBeLessThanOrEqual(g.height);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j])).toBe(false);
      const [c1, c2, c3, c4, c5, c6] = boxes;
      expect(c1.left).toBeLessThan(c2.left);           // 01 then 02 along the top
      expect(c3.top).toBeGreaterThan(c2.top);          // 03 down the right side
      expect(c4.left).toBeGreaterThan(c5.left);        // 04 then 05 back along the bottom
      expect(c6.left).toBeLessThan(c1.left);           // 06 on the left, closing the loop
      expect(g.segments).toHaveLength(6);
      expect(g.path.startsWith('M ')).toBe(true);
      expect(g.path.endsWith('Z')).toBe(true);
      // The track stays inside the width, so the page never scrolls sideways.
      for (const [x] of g.anchors) { expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(width); }
      // The hub sits between the top row and the bottom row's labels.
      expect(g.hubTop).toBeGreaterThan(c1.top + c1.height);
      expect(g.hubTop).toBeLessThan(c4.top - 20);
    });
  }
});

// 2026-10-03: the track is drawn by the shared closedSpline (the round opening's ring uses it too); the
// table's track stays exactly as it was.
describe('the ring track', () => {
  it('is the same closed curve as before closedSpline was shared', () => {
    expect(ringGeometry(800).path).toBe('M 311.0 16.0 C 383.2 -12.8 416.8 -12.8 489.0 16.0 C 561.2 44.8 744.0 134.0 744.0 189.0 C 744.0 244.0 561.2 319.8 489.0 346.0 C 416.8 372.2 383.2 372.2 311.0 346.0 C 238.8 319.8 56.0 244.0 56.0 189.0 C 56.0 134.0 238.8 44.8 311.0 16.0 Z');
    expect(ringGeometry(360).path).toBe('M 121.5 16.0 C 159.3 -17.0 200.8 -17.0 238.5 16.0 C 276.3 49.0 348.0 150.7 348.0 214.0 C 348.0 277.3 276.3 365.7 238.5 396.0 C 200.8 426.3 159.3 426.3 121.5 396.0 C 83.8 365.7 12.0 277.3 12.0 214.0 C 12.0 150.7 83.8 49.0 121.5 16.0 Z');
  });
});
