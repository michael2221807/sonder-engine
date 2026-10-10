import { buildSixCellBoard, DEFAULT_CONVERTER, type ConverterRule, type SixCellTopology } from './default-board';
import type { BoardDef, RunOptions } from '../../engine/plot-vector/core/types';
import { CHANNEL_NAMES } from './contract/types';

export { DEFAULT_CONVERTER, type ConverterRule } from './default-board';

/**
 * The two board shapes a player can switch between (PO 2026-09-29: both are available, charter B4): a line
 * folds back at its ends, a ring keeps going round. Same cells and cards; only the connections differ.
 */
export type BoardShape = SixCellTopology;
export const BOARD_SHAPES: readonly BoardShape[] = ['line', 'ring'];
/** New games and saves from before the switch existed play on the line. */
const DEFAULT_BOARD_SHAPE: BoardShape = 'line';
export function readBoardShape(value: unknown): BoardShape {
  return BOARD_SHAPES.includes(value as BoardShape) ? value as BoardShape : DEFAULT_BOARD_SHAPE;
}

/** The converter rule a save holds; anything else (absent, unknown, both the same) is the default. */
export function readConverter(value: unknown): ConverterRule {
  const v = value && typeof value === 'object' ? value as Partial<ConverterRule> : {};
  const known = (ch: unknown): ch is ConverterRule['from'] => (CHANNEL_NAMES as readonly unknown[]).includes(ch);
  return known(v.from) && known(v.to) && v.from !== v.to ? { from: v.from, to: v.to } : { ...DEFAULT_CONVERTER };
}

/** The run options every AGA vector trip uses (rounds, previews and card rating). */
export const VECTOR_RUN_OPTIONS: RunOptions = { readout: { kind: 'N1', kappa: 10 } };
/** The board a trip runs on. Card rating leaves `converter` out: a card's strength does not follow the player's pick. */
export function vectorBaseBoard(shape: BoardShape = DEFAULT_BOARD_SHAPE, converter?: ConverterRule): BoardDef {
  return buildSixCellBoard({ topology: shape, ...(converter ? { converter } : {}) });
}
