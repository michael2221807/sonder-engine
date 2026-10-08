/**
 * Round folding window for MainGamePanel (R7 step 4): which slice of the chat
 * history is rendered. Pure functions moved out of the panel; the computeds,
 * scrolling and nextTick code stay in the panel and just call these.
 *
 * Two modes:
 *   'tail'   - show the latest N rounds (default, scrolled to bottom)
 *   'pinned' - show +-2 rounds around a search target (5-round window)
 */

export const VISIBLE_ROUND_WINDOW = 5;
export const VISIBLE_ROUND_HALF = 2;
export const LOAD_MORE_INCREMENT = 5;

export type WindowMode = 'tail' | 'pinned';

/** A value, or a getter read only when the value is needed. */
export type Lazy<T> = T | (() => T);

function read<T>(v: Lazy<T>): T {
  return typeof v === 'function' ? (v as () => T)() : v;
}

/** Minimal message shape the window maths needs. */
export interface WindowMessage {
  role: string;
}

/**
 * @param msgs  the displayed messages (system messages already filtered out)
 * @param aPos  indexes of the assistant messages in `msgs`, ascending
 * @param mode  'tail' or 'pinned'
 * @param tail  how many rounds 'tail' mode shows (may be Infinity)
 * @param pinnedIdx  message index the pinned window centres on
 *
 * The last four may be getters. A computed that passes getters reads each source only
 * where the original inline code did (aPos after the empty check, `tail` only in tail
 * mode, `pinnedIdx` only in pinned mode), so its reactive dependencies stay the same.
 */
export function computeVisibleRange(
  msgs: ReadonlyArray<WindowMessage>,
  aPosIn: Lazy<ReadonlyArray<number>>,
  modeIn: Lazy<WindowMode>,
  tailIn: Lazy<number>,
  pinnedIdxIn: Lazy<number>,
): { start: number; end: number } {
  if (msgs.length === 0) return { start: 0, end: 0 };
  const aPos = read(aPosIn);
  if (aPos.length === 0) return { start: 0, end: msgs.length };

  if (read(modeIn) === 'tail') {
    const count = read(tailIn);
    if (aPos.length <= count) return { start: 0, end: msgs.length };
    const startAssistantPos = aPos.length - count;
    const startMsgIdx = aPos[startAssistantPos];
    const start = startMsgIdx > 0 && msgs[startMsgIdx - 1].role === 'user'
      ? startMsgIdx - 1 : startMsgIdx;
    return { start, end: msgs.length };
  }

  // Pinned: show ±HALF rounds around target
  let centerPos = aPos.length - 1;
  for (let j = 0; j < aPos.length; j++) {
    if (aPos[j] >= read(pinnedIdxIn)) { centerPos = j; break; }
  }

  const wStart = Math.max(0, centerPos - VISIBLE_ROUND_HALF);
  const wEnd = Math.min(aPos.length - 1, centerPos + VISIBLE_ROUND_HALF);

  const startMsgIdx = aPos[wStart];
  const start = startMsgIdx > 0 && msgs[startMsgIdx - 1].role === 'user'
    ? startMsgIdx - 1 : startMsgIdx;

  const end = wEnd < aPos.length - 1
    ? aPos[wEnd] + 1
    : msgs.length;

  return { start, end };
}

/** How many assistant rounds sit before message index `start` (i.e. are folded away). */
export function countFoldedBefore(aPos: ReadonlyArray<number>, start: number): number {
  let count = 0;
  for (const pos of aPos) {
    if (pos < start) count++; else break;
  }
  return count;
}
