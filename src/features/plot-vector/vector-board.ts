import { buildSixCellBoard, type SixCellTopology } from './default-board';
import type { BoardDef, RunOptions } from '../../engine/plot-vector/core/types';

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

/** The run options every AGA vector trip uses (rounds, previews and card rating). */
export const VECTOR_RUN_OPTIONS: RunOptions = { readout: { kind: 'N1', kappa: 10 } };
export function vectorBaseBoard(shape: BoardShape = DEFAULT_BOARD_SHAPE): BoardDef { return buildSixCellBoard({ topology: shape }); }
