/**
 * Where the six cells sit on the ring board, and the track the shuttle rides around them (PO 2026-09-29: both
 * shapes; approved demo docs/demo/plot-vector-board.html). 01 02 on top, 03 right, 04 05 below, 06 left:
 * clockwise. The track passes just outside the cells so the shuttle is never hidden under a card.
 */
export const RING_ORDER = ['01', '02', '03', '04', '05', '06'] as const;
export interface CellBox { left: number; top: number; width: number; height: number }
export interface RingGeometry {
  cells: Record<string, CellBox>;
  /** The track's point beside each cell, in RING_ORDER. */
  anchors: Array<[number, number]>;
  /** One cubic segment per cell to the next (the last closes the loop), as SVG path data. */
  segments: string[];
  /** The whole closed track. */
  path: string;
  height: number;
  /** Vertical centre of the hub between the rows, where the tendencies sit. */
  hubTop: number;
  narrow: boolean;
}

const fmt = (p: readonly [number, number]) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;

export function ringGeometry(width: number): RingGeometry {
  const narrow = width < 640;
  const cw = narrow ? Math.floor((width - 16) / 3.4) : 150, ch = narrow ? 96 : 110;
  const topX = cw / 2 + (narrow ? 8 : 14), sideX = narrow ? width / 2 - cw / 2 - 22 : cw * 1.5 + 30;
  const rowStep = narrow ? ch + 26 : 90, top = 44, cx = width / 2, gap = narrow ? 10 : 14;
  const spots: Record<string, [number, number]> = { '01': [-topX, 0], '02': [topX, 0], '03': [sideX, 1], '04': [topX, 2], '05': [-topX, 2], '06': [-sideX, 1] };
  const cells: Record<string, CellBox> = {};
  const anchors: Array<[number, number]> = [];
  for (const id of RING_ORDER) {
    const [x, row] = spots[id];
    const left = cx + x - cw / 2, y = top + row * rowStep;
    cells[id] = { left, top: y, width: cw, height: ch };
    anchors.push(row === 0 ? [cx + x, y - 28] : row === 2 ? [cx + x, y + ch + 12] : [x > 0 ? left + cw + gap : left - gap, y + ch / 2]);
  }
  // A closed smooth curve through the anchors (Catmull-Rom as cubic Béziers).
  const n = anchors.length, segments: string[] = [], curves: string[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = anchors[(i - 1 + n) % n], p1 = anchors[i], p2 = anchors[(i + 1) % n], p3 = anchors[(i + 2) % n];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    segments.push(`M ${fmt(p1)} C ${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`);
    curves.push(`C ${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`);
  }
  return {
    cells, anchors, segments, narrow,
    path: `M ${fmt(anchors[0])} ${curves.join(' ')} Z`,
    height: top + rowStep * 2 + ch + 30,
    hubTop: (top + ch + top + 2 * rowStep - 20) / 2,
  };
}
