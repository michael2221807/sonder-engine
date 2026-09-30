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
    start({ ...down(), pointerType: 'touch' } as unknown as PointerEvent, 'a', 'hand');
    win.dispatchEvent(Object.assign(pointer('pointermove', 20, 0), { pointerType: 'touch' }));
    win.dispatchEvent(Object.assign(pointer('pointerup', 20, 0), { pointerType: 'touch' }));
    expect(onDrop).toHaveBeenCalledWith('a', 'hand', '03');
    expect(vibrate).toHaveBeenCalledWith(8);
  });
});
