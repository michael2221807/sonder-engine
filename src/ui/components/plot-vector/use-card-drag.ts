// App doc: docs/user-guide/pages/game-main.md §3.18.3 · Moving cards
/**
 * Cards move by hand (phase 7): drag a card onto a cell, back to the hand, or onto another card to swap; a tap
 * picks a card up and a second tap on a cell puts it down (phones). A long press on touch lifts the card with a
 * light buzz and opens its details; moving on from there carries it like a drag (the details give way).
 * Drop targets mark themselves with `data-drop-cell="01"` or `data-drop-hand`.
 *
 * On a touch screen the page must not scroll under a card being carried: a scroll takes the gesture and cancels the
 * drag, and the card jumps back. CSS `touch-action` says so, but iOS does not honour it inside a scrolling panel
 * (Changelog: 2026-10-01 a drag snapped back at once on a phone). The host
 * passes `touchMove` to a non-passive `touchmove` listener on the panel, which holds the page still while a card is
 * carried and for a card in a cell that can move; a card that cannot move never holds it. A finger on a card in the
 * hand chooses by its first few pixels: up or down picks the card up (and the page stays held to the end), sideways
 * leaves the swipe to the hand strip, which scrolls — no drag and no tap. A mouse drags in any direction.
 */
import { onBeforeUnmount, ref } from 'vue';
import { buzz } from './table-effects';

export type DropTarget = string | 'hand' | null;
export interface DragState { card: string; from: string; x: number; y: number; over: DropTarget; pointerType: string }

const MOVE_THRESHOLD = 6;
/** A cell this close to the pointer draws the card in, so a drop need not be pixel-exact. */
const PULL = 28;
const LONG_PRESS_MS = 480;
/** A finger on a hand card picks it up when it starts more up or down than this share of its sideways move. */
const VERTICAL = 0.7;
/** Whether a finger's first move from (dx, dy) reads as picking a hand card up rather than swiping the hand. */
const vertical = (dx: number, dy: number) => Math.abs(dy) > Math.abs(dx) * VERTICAL;

export function useCardDrag(opts: {
  canDrag: (card: string) => boolean;
  onDrop: (card: string, from: string, to: DropTarget) => void;
  onTap: (card: string, from: string, el: HTMLElement) => void;
  onLongPress: (card: string, el: HTMLElement) => void;
}) {
  const drag = ref<DragState | null>(null);
  let release: (() => void) | null = null;
  /** The gesture under way, for `touchMove`: where it began, where the pointer was last, and how it stands. */
  interface Gesture {
    card: string; from: string; sx: number; sy: number; x: number; y: number;
    /** `swiped`: a finger went sideways on a hand card, which scrolls the hand instead. */
    state: { moved: boolean; pressed: boolean; blocked: boolean; swiped: boolean };
  }
  let gesture: Gesture | null = null;

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
    const g = { moved: false, pressed: false, blocked: false, swiped: false };
    const current: Gesture = { card, from, sx, sy, x: sx, y: sy, state: g };
    gesture = current;
    const pointerType = e.pointerType;
    const longPress = pointerType !== 'mouse'
      ? setTimeout(() => { if (!g.moved) { g.pressed = true; buzz(12); opts.onLongPress(card, el); } }, LONG_PRESS_MS) : undefined;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      current.x = ev.clientX; current.y = ev.clientY;
      if (g.blocked || g.swiped) return;
      if (!g.moved) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < MOVE_THRESHOLD) return;
        clearTimeout(longPress);
        // A card that cannot move: the gesture ends as a tap (which shows its details).
        if (!opts.canDrag(card)) { g.blocked = true; return; }
        // A finger going sideways on a hand card is scrolling the hand, unless a long press already picked it up.
        if (pointerType !== 'mouse' && from === 'hand' && !g.pressed && !vertical(ev.clientX - sx, ev.clientY - sy)) { g.swiped = true; return; }
        g.moved = true;
      }
      ev.preventDefault();
      drag.value = { card, from, x: ev.clientX, y: ev.clientY, over: targetAt(ev.clientX, ev.clientY), pointerType };
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      cleanup();
      if (g.moved) {
        const done = drag.value;
        drag.value = null;
        if (done?.over && pointerType !== 'mouse') buzz(8);
        if (done) opts.onDrop(card, from, done.over);
      } else if (!g.pressed && !g.swiped) opts.onTap(card, from, el);
    };
    // The browser took the gesture (a scroll of the hand): nothing moves.
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === pid) { cleanup(); drag.value = null; } };
    const cleanup = () => {
      clearTimeout(longPress);
      gesture = null;
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
  /** For a non-passive `touchmove` listener on the panel holding the cards: keeps the page from scrolling under a card. */
  function touchMove(ev: TouchEvent): void {
    const g = gesture;
    if (!g || g.state.blocked || g.state.swiped || !ev.cancelable || !ev.touches.length) return;
    // A card that cannot move lets the page scroll from the first touch on.
    if (!opts.canDrag(g.card)) return;
    // Carried (a hand card is only carried after an up-or-down start, see `move`), long-pressed, or in a cell: held, and
    // held to the end of the gesture whatever the finger does next.
    if (g.state.moved || g.state.pressed || g.from !== 'hand') { ev.preventDefault(); return; }
    // A hand card not yet decided: held once the finger has clearly started up or down (a sideways flick
    // that begins with a pixel of jitter still scrolls the hand). With two fingers, the one nearest the pointer.
    let t = ev.touches[0];
    for (const touch of Array.from(ev.touches)) {
      if (Math.hypot(touch.clientX - g.x, touch.clientY - g.y) < Math.hypot(t.clientX - g.x, t.clientY - g.y)) t = touch;
    }
    const dx = t.clientX - g.sx, dy = t.clientY - g.sy;
    if (Math.hypot(dx, dy) >= MOVE_THRESHOLD && vertical(dx, dy)) ev.preventDefault();
  }
  onBeforeUnmount(() => { release?.(); drag.value = null; });
  return { drag, start, touchMove };
}
