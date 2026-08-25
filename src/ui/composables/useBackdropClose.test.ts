import { describe, it, expect, vi } from 'vitest';
import { useBackdropClose } from './useBackdropClose';

/**
 * Synthetic pointer-event stub. The composable only reads target,
 * currentTarget, button, and pointerId, so a plain object suffices.
 */
function ev(target: unknown, currentTarget: unknown, button = 0, pointerId = 1): PointerEvent {
  return { target, currentTarget, button, pointerId } as PointerEvent;
}

describe('useBackdropClose', () => {
  const overlay = { name: 'overlay' };
  const panel = { name: 'panel' };

  it('fires when both pointerdown and pointerup land on the backdrop itself', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    b.onPointerdown(ev(overlay, overlay));
    b.onPointerup(ev(overlay, overlay));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when the press starts inside the panel and ends on the backdrop (drag-out)', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    // Bubbled pointerdown from the panel: target=panel, currentTarget=overlay.
    b.onPointerdown(ev(panel, overlay));
    // Browser would dispatch click on the common ancestor — but our pointerup
    // sees the real release target. Even a release directly on the overlay
    // must not fire because the press was not armed.
    b.onPointerup(ev(overlay, overlay));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT fire when the press starts on the backdrop and ends inside the panel (drag-in)', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    b.onPointerdown(ev(overlay, overlay));
    b.onPointerup(ev(panel, overlay));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT fire for non-primary buttons', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    b.onPointerdown(ev(overlay, overlay, 2));
    b.onPointerup(ev(overlay, overlay, 2));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disarms after each release — a later panel-originated release cannot reuse a stale arm', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    b.onPointerdown(ev(overlay, overlay));
    b.onPointerup(ev(panel, overlay)); // drag-in, no fire, must disarm
    b.onPointerup(ev(overlay, overlay)); // stray release without a new press
    expect(onClose).not.toHaveBeenCalled();
    // A clean new press still works.
    b.onPointerdown(ev(overlay, overlay));
    b.onPointerup(ev(overlay, overlay));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when a DIFFERENT pointer releases on the backdrop (multi-touch)', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    b.onPointerdown(ev(overlay, overlay, 0, 1)); // finger 1 arms
    b.onPointerup(ev(overlay, overlay, 0, 2)); // finger 2 releases
    expect(onClose).not.toHaveBeenCalled();
  });

  it('re-arms correctly across successive presses', () => {
    const onClose = vi.fn();
    const b = useBackdropClose(onClose);
    b.onPointerdown(ev(panel, overlay)); // press inside panel
    b.onPointerup(ev(panel, overlay));
    b.onPointerdown(ev(overlay, overlay)); // then a genuine backdrop press
    b.onPointerup(ev(overlay, overlay));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
