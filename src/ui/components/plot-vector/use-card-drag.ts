/**
 * Cards move by hand (phase 7): drag a card onto a cell, back to the hand, or onto another card to swap; a tap
 * picks a card up and a second tap on a cell puts it down (phones). A long press on touch opens the details.
 * Drop targets mark themselves with `data-drop-cell="01"` or `data-drop-hand`.
 */
import { onBeforeUnmount, ref } from 'vue';

export type DropTarget = string | 'hand' | null;
export interface DragState { card: string; from: string; x: number; y: number; over: DropTarget }

const MOVE_THRESHOLD = 6;
const LONG_PRESS_MS = 480;

export function useCardDrag(opts: {
  canDrag: (card: string) => boolean;
  onDrop: (card: string, from: string, to: DropTarget) => void;
  onTap: (card: string, from: string, el: HTMLElement) => void;
  onLongPress: (card: string, el: HTMLElement) => void;
}) {
  const drag = ref<DragState | null>(null);
  let release: (() => void) | null = null;

  function targetAt(x: number, y: number): DropTarget {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const cell = hit?.closest<HTMLElement>('[data-drop-cell]');
    if (cell?.dataset.dropCell) return cell.dataset.dropCell;
    return hit?.closest('[data-drop-hand]') ? 'hand' : null;
  }

  /** `from` is the cell the card sits in, or 'hand'. */
  function start(e: PointerEvent, card: string, from: string): void {
    if (e.button !== 0 || release) return;
    const el = e.currentTarget as HTMLElement;
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let moved = false, pressed = false, blocked = false;
    const longPress = e.pointerType !== 'mouse'
      ? setTimeout(() => { if (!moved) { pressed = true; opts.onLongPress(card, el); } }, LONG_PRESS_MS) : undefined;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid || pressed || blocked) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < MOVE_THRESHOLD) return;
        clearTimeout(longPress);
        // A card that cannot move: the gesture ends as a tap (which shows its details).
        if (!opts.canDrag(card)) { blocked = true; return; }
        moved = true;
      }
      ev.preventDefault();
      drag.value = { card, from, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY) };
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      cleanup();
      if (moved) {
        const done = drag.value;
        drag.value = null;
        if (done) opts.onDrop(card, from, done.over);
      } else if (!pressed) opts.onTap(card, from, el);
    };
    // The browser took the gesture (a scroll of the hand): nothing moves.
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === pid) { cleanup(); drag.value = null; } };
    const cleanup = () => {
      clearTimeout(longPress);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      release = null;
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    release = cleanup;
  }
  onBeforeUnmount(() => { release?.(); drag.value = null; });
  return { drag, start };
}
