import type { BoardDef, ChannelMeta, CompiledBoard } from './types';

/** Bipolar dimensions own a positive and a negative channel; unipolar ones a single channel. */
function channelsOf(board: Pick<BoardDef, 'dimensions'>): ChannelMeta[] {
  const out: ChannelMeta[] = [];
  for (const d of board.dimensions) {
    if (d.polarity === 'bipolar') {
      out.push({ id: `${d.id}+`, dimension: d.id, pole: 'positive' });
      out.push({ id: `${d.id}-`, dimension: d.id, pole: 'negative' });
    } else {
      out.push({ id: d.id, dimension: d.id, pole: 'positive' });
    }
  }
  return out;
}

/** Compile a board: derive its channels. Nothing else is invented here. */
export function compileBoard(def: BoardDef): CompiledBoard {
  return { ...def, channels: channelsOf(def) };
}
