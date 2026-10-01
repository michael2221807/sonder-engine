import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCardDrag } from './use-card-drag';

// Node test: the window is an event target, and the point under the pointer is a stubbed cell.
let win: EventTarget;
beforeEach(() => {
  win = new EventTarget();
  vi.stubGlobal('window', win);
  const cell = { dataset: { dropCell: '03' }, closest: (sel: string) => (sel === '[data-drop-cell]' ? cell : null) };
  vi.stubGlobal('document', { elementFromPoint: () => ({ closest: (sel: string) => (sel === '[data-drop-cell]' ? cell : null) }) });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function pointer(type: string, x: number, y: number): Event {
  const e = new Event(type);
  Object.assign(e, { pointerId: 1, clientX: x, clientY: y, button: 0, pointerType: 'mouse' });
  return e;
}
const down = (x = 0, y = 0) => ({ pointerId: 1, clientX: x, clientY: y, button: 0, pointerType: 'mouse', currentTarget: {} }) as unknown as PointerEvent;

/** A touchmove the panel's listener sees: where the finger is, and whether it may still be stopped. */
const touchMove = (x: number, y: number, cancelable = true, more: Array<{ clientX: number; clientY: number }> = []) =>
  ({ touches: [...more, { clientX: x, clientY: y }], cancelable, preventDefault: vi.fn() }) as unknown as TouchEvent & { preventDefault: ReturnType<typeof vi.fn> };
const touchDown = (x = 0, y = 0) => ({ ...down(x, y), pointerType: 'touch' }) as unknown as PointerEvent;

describe('a touch drag is not taken by a scroll (PO 2026-10-01: iOS, ring board)', () => {
  it('holds the page still for a card in a cell, and for a hand card moved up or down; sideways the hand scrolls', () => {
    const { start, touchMove: held } = useCardDrag({ canDrag: () => true, onDrop: vi.fn(), onTap: vi.fn(), onLongPress: vi.fn() });
    start(touchDown(100, 300), 'a', '02');
    let ev = touchMove(103, 301);
    held(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    win.dispatchEvent(pointer('pointercancel', 0, 0));
    start(touchDown(100, 600), 'b', 'hand');
    ev = touchMove(102, 590);
    held(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    win.dispatchEvent(pointer('pointercancel', 0, 0));
    start(touchDown(100, 600), 'b', 'hand');
    ev = touchMove(130, 602);
    held(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    win.dispatchEvent(pointer('pointercancel', 0, 0));
  });
  it('a finger going sideways on a hand card scrolls the hand: no drag, no tap, the page not held; a mouse still drags sideways', () => {
    const onDrop = vi.fn(), onTap = vi.fn();
    const { start, drag, touchMove: held } = useCardDrag({ canDrag: () => true, onDrop, onTap, onLongPress: vi.fn() });
    start(touchDown(100, 600), 'b', 'hand');
    win.dispatchEvent(Object.assign(pointer('pointermove', 110, 601), { pointerType: 'touch' }));
    expect(drag.value).toBeNull();
    const ev = touchMove(118, 602);
    held(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    win.dispatchEvent(pointer('pointerup', 118, 602));
    expect(onTap).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    start(down(100, 600), 'b', 'hand');
    win.dispatchEvent(pointer('pointermove', 130, 600));
    expect(drag.value).toMatchObject({ card: 'b' });
    win.dispatchEvent(pointer('pointercancel', 0, 0));
  });
  it('a card being carried keeps the page still whatever the direction; nothing is held without a gesture or once the browser scrolls', () => {
    const { start, touchMove: held } = useCardDrag({ canDrag: () => true, onDrop: vi.fn(), onTap: vi.fn(), onLongPress: vi.fn() });
    const idle = touchMove(0, 50);
    held(idle);
    expect(idle.preventDefault).not.toHaveBeenCalled();
    start(touchDown(100, 600), 'b', 'hand');
    win.dispatchEvent(Object.assign(pointer('pointermove', 100, 560), { pointerType: 'touch' }));
    const sideways = touchMove(160, 560);
    held(sideways);
    expect(sideways.preventDefault).toHaveBeenCalled();
    const late = touchMove(100, 500, false);
    held(late);
    expect(late.preventDefault).not.toHaveBeenCalled();
    win.dispatchEvent(pointer('pointerup', 160, 560));
    const after = touchMove(100, 500);
    held(after);
    expect(after.preventDefault).not.toHaveBeenCalled();
  });
  it('a card that cannot move lets the page scroll, from the first pixel on', () => {
    const { start, touchMove: held } = useCardDrag({ canDrag: () => false, onDrop: vi.fn(), onTap: vi.fn(), onLongPress: vi.fn() });
    start(touchDown(100, 300), 'resting', '02');
    const first = touchMove(100, 298);
    held(first);
    expect(first.preventDefault).not.toHaveBeenCalled();
    win.dispatchEvent(Object.assign(pointer('pointermove', 100, 260), { pointerType: 'touch' }));
    const ev = touchMove(100, 250);
    held(ev);
    expect(ev.preventDefault).not.toHaveBeenCalled();
    win.dispatchEvent(pointer('pointercancel', 0, 0));
  });
  it('a hand card with a pixel or two of jitter is not held yet: a sideways flick that starts that way still scrolls the hand', () => {
    const { start, touchMove: held } = useCardDrag({ canDrag: () => true, onDrop: vi.fn(), onTap: vi.fn(), onLongPress: vi.fn() });
    start(touchDown(100, 600), 'b', 'hand');
    for (const [x, y] of [[100, 601], [101, 602], [100, 599]]) {
      const ev = touchMove(x, y);
      held(ev);
      expect(ev.preventDefault).not.toHaveBeenCalled();
    }
    win.dispatchEvent(pointer('pointercancel', 0, 0));
  });
  it('with a second finger down, the direction is read from the finger nearest the pointer', () => {
    const { start, touchMove: held } = useCardDrag({ canDrag: () => true, onDrop: vi.fn(), onTap: vi.fn(), onLongPress: vi.fn() });
    start(touchDown(100, 600), 'b', 'hand');
    // The other finger sits far away and still; the dragging one goes up.
    const ev = touchMove(101, 585, true, [{ clientX: 300, clientY: 200 }]);
    held(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    win.dispatchEvent(pointer('pointercancel', 0, 0));
  });
});

describe('moving cards by hand', () => {
  it('a drag onto a cell drops the card there', () => {
    const onDrop = vi.fn(), onTap = vi.fn();
    const { start, drag } = useCardDrag({ canDrag: () => true, onDrop, onTap, onLongPress: vi.fn() });
    start(down(), 'a', 'hand');
    win.dispatchEvent(pointer('pointermove', 20, 0));
    expect(drag.value).toMatchObject({ card: 'a', over: '03' });
    win.dispatchEvent(pointer('pointerup', 20, 0));
    expect(onDrop).toHaveBeenCalledWith('a', 'hand', '03');
    expect(onTap).not.toHaveBeenCalled();
    expect(drag.value).toBeNull();
  });
  it('a drag on a card that cannot move ends as a tap (its details), not in silence', () => {
    const onDrop = vi.fn(), onTap = vi.fn();
    const { start, drag } = useCardDrag({ canDrag: () => false, onDrop, onTap, onLongPress: vi.fn() });
    start(down(), 'resting', 'hand');
    win.dispatchEvent(pointer('pointermove', 30, 0));
    expect(drag.value).toBeNull();
    win.dispatchEvent(pointer('pointerup', 30, 0));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledWith('resting', 'hand', expect.anything());
  });
  it('a press without moving is a tap; a scroll the browser takes moves nothing', () => {
    const onDrop = vi.fn(), onTap = vi.fn();
    const { start } = useCardDrag({ canDrag: () => true, onDrop, onTap, onLongPress: vi.fn() });
    start(down(), 'a', '01');
    win.dispatchEvent(pointer('pointerup', 2, 1));
    expect(onTap).toHaveBeenCalledWith('a', '01', expect.anything());
    start(down(), 'b', 'hand');
    win.dispatchEvent(pointer('pointercancel', 0, 0));
    win.dispatchEvent(pointer('pointerup', 50, 50));
    expect(onDrop).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(1);
  });
  it('a drop just beside a cell is drawn into the nearest cell within reach; farther away it lands nowhere', () => {
    const cell = (id: string, left: number) => ({ dataset: { dropCell: id }, getBoundingClientRect: () => ({ left, right: left + 100, top: 0, bottom: 80 }) });
    vi.stubGlobal('document', {
      elementFromPoint: () => ({ closest: () => null }),
      querySelectorAll: () => [cell('01', 0), cell('02', 130)],
    });
    const onDrop = vi.fn();
    const { start, drag } = useCardDrag({ canDrag: () => true, onDrop, onTap: vi.fn(), onLongPress: vi.fn() });
    start(down(), 'a', 'hand');
    // 12 px right of 01, 18 px left of 02: the nearer one wins.
    win.dispatchEvent(pointer('pointermove', 112, 40));
    expect(drag.value?.over).toBe('01');
    // 40 px under both: out of reach.
    win.dispatchEvent(pointer('pointermove', 50, 120));
    expect(drag.value?.over).toBeNull();
    win.dispatchEvent(pointer('pointerup', 50, 120));
    expect(onDrop).toHaveBeenCalledWith('a', 'hand', null);
  });
  it('a long press lifts the card with its details; moving on carries it, letting go in place does not tap', () => {
    vi.useFakeTimers();
    try {
      const vibrate = vi.fn();
      vi.stubGlobal('navigator', { vibrate });
      const onDrop = vi.fn(), onTap = vi.fn(), onLongPress = vi.fn();
      const { start, drag } = useCardDrag({ canDrag: () => true, onDrop, onTap, onLongPress });
      const touch = (type: string, x: number, y: number) => win.dispatchEvent(Object.assign(pointer(type, x, y), { pointerType: 'touch' }));
      start({ ...down(), pointerType: 'touch' } as unknown as PointerEvent, 'a', 'hand');
      vi.advanceTimersByTime(500);
      expect(onLongPress).toHaveBeenCalledWith('a', expect.anything());
      expect(vibrate).toHaveBeenCalledWith(12);
      touch('pointermove', 0, -30);
      expect(drag.value).toMatchObject({ card: 'a', pointerType: 'touch' });
      touch('pointerup', 0, -30);
      expect(onDrop).toHaveBeenCalledWith('a', 'hand', '03');
      // Held and let go without moving: only the details, no tap.
      start({ ...down(), pointerType: 'touch' } as unknown as PointerEvent, 'b', 'hand');
      vi.advanceTimersByTime(500);
      touch('pointerup', 1, 1);
      expect(onTap).not.toHaveBeenCalled();
      expect(onLongPress).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it('on a touch screen a drop onto a cell gives a light tap', () => {
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', { vibrate });
    const onDrop = vi.fn();
    const { start } = useCardDrag({ canDrag: () => true, onDrop, onTap: vi.fn(), onLongPress: vi.fn() });
    // A finger picks a hand card up by moving it up (sideways would scroll the hand).
    start({ ...down(), pointerType: 'touch' } as unknown as PointerEvent, 'a', 'hand');
    win.dispatchEvent(Object.assign(pointer('pointermove', 4, -20), { pointerType: 'touch' }));
    win.dispatchEvent(Object.assign(pointer('pointerup', 4, -20), { pointerType: 'touch' }));
    expect(onDrop).toHaveBeenCalledWith('a', 'hand', '03');
    expect(vibrate).toHaveBeenCalledWith(8);
  });
});
