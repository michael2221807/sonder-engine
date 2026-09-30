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
});
