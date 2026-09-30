/**
 * Cards move by hand (phase 7): drag a card onto a cell, back to the hand, or onto another card to swap; a tap
 * picks a card up and a second tap on a cell puts it down (phones). A long press on touch lifts the card with a
 * light buzz and opens its details; moving on from there carries it like a drag (the details give way).
 * Drop targets mark themselves with `data-drop-cell="01"` or `data-drop-hand`.
 */
import { onBeforeUnmount, ref } from 'vue';
import { buzz } from './table-effects';

export type DropTarget = string | 'hand' | null;
export interface DragState { card: string; from: string; x: number; y: number; over: DropTarget; pointerType: string }

const MOVE_THRESHOLD = 6;
/** A cell this close to the pointer draws the card in, so a drop need not be pixel-exact. */
const PULL = 28;
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
    if (hit?.closest('[data-drop-hand]')) return 'hand';
    // Near a cell but not on it: the nearest one within reach.
    let best: { id: string; d: number } | null = null;
    for (const el of document.querySelectorAll<HTMLElement>('[data-drop-cell]')) {
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom), d = Math.hypot(dx, dy);
      if (d <= PULL && el.dataset.dropCell && (!best || d < best.d)) best = { id: el.dataset.dropCell, d };
    }
    return best?.id ?? null;
  }

  /** `from` is the cell the card sits in, or 'hand'. */
  function start(e: PointerEvent, card: string, from: string): void {
    if (e.button !== 0 || release) return;
    const el = e.currentTarget as HTMLElement;
    const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
    let moved = false, pressed = false, blocked = false;
    const pointerType = e.pointerType;
    const longPress = pointerType !== 'mouse'
      ? setTimeout(() => { if (!moved) { pressed = true; buzz(12); opts.onLongPress(card, el); } }, LONG_PRESS_MS) : undefined;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid || blocked) return;
      if (!moved) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < MOVE_THRESHOLD) return;
        clearTimeout(longPress);
        // A card that cannot move: the gesture ends as a tap (which shows its details).
        if (!opts.canDrag(card)) { blocked = true; return; }
        moved = true;
      }
      ev.preventDefault();
      drag.value = { card, from, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY), pointerType };
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      cleanup();
      if (moved) {
        const done = drag.value;
        drag.value = null;
        if (done?.over && pointerType !== 'mouse') buzz(8);
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
