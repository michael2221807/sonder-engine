import type { BoardDef, EffectDef, Provenance } from '../../engine/plot-vector/core/types';
import { SHUTTLE_ACCOUNT } from '../../engine/plot-vector/core/runner';

const SIX_CELL_ID = 'six-cell';
export const SIX_CELL_RING_ID = 'six-cell-ring';
export type SixCellTopology = 'line' | 'ring';
export interface SixCellOptions {
  topology?: SixCellTopology;
  tripLength?: number;
}

const CH = { Sp: 'S+', Sm: 'S-', Y: 'Y', J: 'J' } as const;
const TEMPLATE: Provenance = { concept: 'PO', params: 'Codex' };

function resonance(cellId: string): EffectDef {
  return {
    id: `${cellId}:resonance`,
    owner: { kind: 'cell', id: cellId },
    event: 'modifyOperation',
    order: 0,
    operations: [],
    modifier: {
      kind: 'adjacencyCount',
      selector: { ownerKind: 'card', opKind: 'add' },
      neighborTag: 'resonant',
      requiresCard: true,
      perNeighbor: 0.25,
      maxCount: 2,
    },
    source: 'PO',
    provenance: TEMPLATE,
    label: {
      zh: '相邻的共鸣格里也放了卡时，本格卡的加量每有一个这样的邻格 +25%（最多两个）',
      en: 'For each adjacent resonance cell that also holds a card, this cell\'s card adds 25% more (up to two)',
    },
  };
}

/** The two chains both topologies share; only the wrap edges differ. */
const FORWARD = [
  { id: '01>02', kind: 'forward' as const, from: { cell: '01', port: 'R' as const }, to: { cell: '02', port: 'L' as const }, label: { zh: '01 → 02', en: '01 → 02' } },
  { id: '02>03', kind: 'forward' as const, from: { cell: '02', port: 'R' as const }, to: { cell: '03', port: 'L' as const }, label: { zh: '02 → 03', en: '02 → 03' } },
  { id: '03>04', kind: 'forward' as const, from: { cell: '03', port: 'R' as const }, to: { cell: '04', port: 'L' as const }, label: { zh: '03 → 04', en: '03 → 04' } },
  { id: '04>05', kind: 'forward' as const, from: { cell: '04', port: 'R' as const }, to: { cell: '05', port: 'L' as const }, label: { zh: '04 → 05', en: '04 → 05' } },
  { id: '05>06', kind: 'forward' as const, from: { cell: '05', port: 'R' as const }, to: { cell: '06', port: 'L' as const }, label: { zh: '05 → 06', en: '05 → 06' } },
];
const REVERSE = [
  { id: '06<05', kind: 'reverse' as const, from: { cell: '06', port: 'L' as const }, to: { cell: '05', port: 'R' as const }, label: { zh: '06 → 05（反向）', en: '06 → 05 (backward)' } },
  { id: '05<04', kind: 'reverse' as const, from: { cell: '05', port: 'L' as const }, to: { cell: '04', port: 'R' as const }, label: { zh: '05 → 04（反向）', en: '05 → 04 (backward)' } },
  { id: '04<03', kind: 'reverse' as const, from: { cell: '04', port: 'L' as const }, to: { cell: '03', port: 'R' as const }, label: { zh: '04 → 03（反向）', en: '04 → 03 (backward)' } },
  { id: '03<02', kind: 'reverse' as const, from: { cell: '03', port: 'L' as const }, to: { cell: '02', port: 'R' as const }, label: { zh: '03 → 02（反向）', en: '03 → 02 (backward)' } },
  { id: '02<01', kind: 'reverse' as const, from: { cell: '02', port: 'L' as const }, to: { cell: '01', port: 'R' as const }, label: { zh: '02 → 01（反向）', en: '02 → 01 (backward)' } },
];

export function buildSixCellBoard(opts: SixCellOptions = {}): BoardDef {
  const topology: SixCellTopology = opts.topology ?? 'line';
  return {
    id: topology === 'ring' ? SIX_CELL_RING_ID : SIX_CELL_ID,
    // Same cells, same cards: one layout serves both topologies.
    layoutKey: SIX_CELL_ID,
    label:
      topology === 'ring'
        ? { zh: '六格环形盘（一直绕行）', en: 'Six-cell ring board (keeps going round)' }
        : { zh: '六格线形盘（走到头自动折返）', en: 'Six-cell line board (folds back at the ends)' },
    dimensions: [
      {
        id: 'S',
        polarity: 'bipolar',
        label: { zh: '顺利', en: 'Going well' },
        poleLabels: { negative: { zh: '阻力', en: 'drag' }, positive: { zh: '推力', en: 'push' } },
      },
      { id: 'Y', polarity: 'unipolar', label: { zh: '人际', en: 'Relations' } },
      { id: 'J', polarity: 'unipolar', label: { zh: '机会', en: 'Openings' } },
    ],
    // Deterministic validation seed; the AGA host replaces this payload before a real run.
    startPayload: { [CH.Sp]: 4, [CH.Sm]: 0, [CH.Y]: 2, [CH.J]: 0 },
    cells: [
      {
        id: '01',
        kind: 'resonance',
        tags: ['resonant'],
        ports: ['L', 'R'],
        effects: [resonance('01')],
        locked: false,
        source: 'PO',
        provenance: TEMPLATE,
        label: { zh: '共鸣格', en: 'Resonance cell' },
      },
      {
        id: '02',
        kind: 'resonance',
        tags: ['resonant'],
        ports: ['L', 'R'],
        effects: [resonance('02')],
        locked: false,
        source: 'PO',
        provenance: TEMPLATE,
        label: { zh: '共鸣格', en: 'Resonance cell' },
      },
      {
        id: '03',
        kind: 'converter',
        tags: ['converter'],
        ports: ['L', 'R'],
        effects: [
          {
            id: '03:convert-forward',
            owner: { kind: 'cell', id: '03' },
            event: 'afterCard',
            order: 10,
            entryPort: 'L',
            operations: [{ op: 'convert', target: SHUTTLE_ACCOUNT, from: CH.Sp, to: CH.Y, rate: 0.5, efficiency: 1 }],
            source: 'PO',
            provenance: TEMPLATE,
            label: { zh: '正向经过：把梭上一半的「顺利·推力」转成「人际」', en: 'Entering forward: half of the push on the shuttle turns into Relations' },
          },
          {
            id: '03:convert-reverse',
            owner: { kind: 'cell', id: '03' },
            event: 'afterCard',
            order: 10,
            entryPort: 'R',
            operations: [{ op: 'convert', target: SHUTTLE_ACCOUNT, from: CH.Y, to: CH.J, rate: 0.5, efficiency: 1 }],
            source: 'PO',
            provenance: TEMPLATE,
            label: { zh: '反向经过：把梭上一半的「人际」转成「机会」', en: 'Entering backward: half of the Relations on the shuttle turns into Openings' },
          },
        ],
        locked: false,
        source: 'PO',
        provenance: TEMPLATE,
        label: { zh: '转换格（两个方向各一组通道）', en: 'Converter cell (one channel set per direction)' },
      },
      {
        id: '04',
        kind: 'effectSlot',
        tags: ['effectSlot'],
        ports: ['L', 'R'],
        effects: [],
        locked: false,
        source: 'Codex',
        provenance: TEMPLATE,
        label: { zh: '效果格（空槽不产出）', en: 'Effect slot (empty produces nothing)' },
      },
      {
        id: '05',
        kind: 'effectSlot',
        tags: ['effectSlot'],
        ports: ['L', 'R'],
        effects: [],
        locked: false,
        source: 'Codex',
        provenance: TEMPLATE,
        label: { zh: '效果格（空槽不产出）', en: 'Effect slot (empty produces nothing)' },
      },
      {
        // The run now ends when the trip length is used up, so this cell carries no
        // ending job any more. It is an ordinary slot like any other.
        id: '06',
        kind: 'plain',
        tags: ['plain'],
        ports: ['L', 'R'],
        effects: [],
        locked: false,
        source: 'Codex',
        provenance: TEMPLATE,
        label: { zh: '普通格（本身没有固定规则）', en: 'Plain cell (no fixed rule of its own)' },
      },
    ],
    edges: [
      // Forward chain. On a ring the last forward edge wraps back to 01; on a line it is
      // absent, which is what makes 06 an endpoint the shuttle folds at.
      ...FORWARD.map((e) => ({ ...e })),
      ...(topology === 'ring'
        ? [{ id: '06>01', kind: 'forward' as const, from: { cell: '06', port: 'R' as const }, to: { cell: '01', port: 'L' as const }, label: { zh: '06 → 01（完成一圈）', en: '06 → 01 (one lap)' } }]
        : []),
      // Reverse chain: the way back. A natural fold at an endpoint uses these and costs
      // nothing; the return card uses them too and pays whatever the card declares.
      ...REVERSE.map((e) => ({ ...e })),
      ...(topology === 'ring'
        ? [{ id: '01<06', kind: 'reverse' as const, from: { cell: '01', port: 'L' as const }, to: { cell: '06', port: 'R' as const }, label: { zh: '01 → 06（反向绕行）', en: '01 → 06 (going round the other way)' } }]
        : []),
    ],
    adjacency: [['01', '02']],
    start: { cell: '01', entryPort: 'L' },
    // The run ends when the trip length is used up; at an end of the line the shuttle folds.
    budget: { maxVisits: 60, maxEvents: 800 },
    traversal: { nMax: 24, nDefault: opts.tripLength ?? 6 },
    cards: [],
  };
}
