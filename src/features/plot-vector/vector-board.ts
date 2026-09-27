import { buildSixCellBoard } from './default-board';
import type { BoardDef, RunOptions } from '../../engine/plot-vector/core/types';

/** The single board and run options every AGA vector trip uses (rounds, previews and card rating). */
export const VECTOR_RUN_OPTIONS: RunOptions = { readout: { kind: 'N1', kappa: 10 } };
export function vectorBaseBoard(): BoardDef { return buildSixCellBoard({ topology: 'line' }); }
