/**
 * useBackdropClose — guarded "press the backdrop to dismiss" for overlay layers.
 *
 * Why not `@click.self`: when a drag STARTS inside the dialog panel and ENDS on
 * the backdrop (text selection in an input, slider drags, image drags), the
 * browser dispatches the resulting `click` on the nearest common ancestor of
 * mousedown/mouseup targets — the backdrop itself — so `.self` passes and the
 * dialog closes, destroying whatever the user had typed. This helper only
 * dismisses when BOTH pointerdown and pointerup land on the backdrop element
 * itself with the primary button, so cross-boundary drags never dismiss.
 *
 * Usage (bind WITHOUT `.self` — the handlers do their own target check and
 * need to see bubbled pointerdowns to disarm):
 *
 *   const backdrop = useBackdropClose(() => close());
 *   <div class="overlay"
 *        @pointerdown="backdrop.onPointerdown"
 *        @pointerup="backdrop.onPointerup">
 */
export interface BackdropCloseHandlers {
  onPointerdown: (e: PointerEvent) => void;
  onPointerup: (e: PointerEvent) => void;
}

export function useBackdropClose(onBackdropPress: () => void): BackdropCloseHandlers {
  /** pointerId of the in-flight primary press that started ON the backdrop; null otherwise. */
  let armedPointerId: number | null = null;
  return {
    onPointerdown(e: PointerEvent): void {
      // Reassign on EVERY press reaching the overlay (including bubbled ones
      // from the panel) so a stale arm can never survive into a later press.
      // Tracking the pointerId ties the release to this exact contact —
      // in multi-touch a second finger's pointerup cannot satisfy the arm.
      armedPointerId = e.target === e.currentTarget && e.button === 0 ? e.pointerId : null;
    },
    onPointerup(e: PointerEvent): void {
      const fire =
        armedPointerId === e.pointerId && e.target === e.currentTarget && e.button === 0;
      armedPointerId = null;
      if (fire) onBackdropPress();
    },
  };
}
