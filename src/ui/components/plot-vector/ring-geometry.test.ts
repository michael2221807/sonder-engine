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
