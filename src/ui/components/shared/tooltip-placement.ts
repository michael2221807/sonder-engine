/**
 * Where a `fixed` Tooltip bubble goes (Tooltip.vue): above or below its trigger, whole inside the viewport.
 *
 * PO 2026-10-04: a long hint over the status bar went off the top of the screen. The old rule assumed a
 * two-line bubble ("above when 72px of room"); the bubble's real size is measured now, and the side it
 * prefers is the Tooltip's own `position` (the status bar's hints prefer below).
 */

export type FixedTipSide = 'top' | 'bottom';

/** The trigger's box in viewport pixels (a DOMRect fits). */
export interface FixedTipTrigger {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export interface FixedTipSize {
  width: number;
  height: number;
}

/** The bubble's top-left corner in viewport pixels, and the side of the trigger it ended up on. */
export interface FixedTipPlacement {
  side: FixedTipSide;
  left: number;
  top: number;
}

/** Space between the trigger and the bubble. */
export const FIXED_TIP_GAP = 6;
/** Space the bubble keeps from the viewport's edges. */
export const FIXED_TIP_MARGIN = 8;

/**
 * The preferred side when the bubble fits there, else the other side when it fits there, else the side with
 * more room. Then the bubble is kept inside the viewport, even if that means covering part of the trigger
 * (it takes no pointer events, so the hover holds).
 */
export function placeFixedTip(
  trigger: FixedTipTrigger,
  bubble: FixedTipSize,
  viewport: FixedTipSize,
  prefer: FixedTipSide,
): FixedTipPlacement {
  const room: Record<FixedTipSide, number> = {
    top: trigger.top - FIXED_TIP_GAP - FIXED_TIP_MARGIN,
    bottom: viewport.height - trigger.bottom - FIXED_TIP_GAP - FIXED_TIP_MARGIN,
  };
  const other: FixedTipSide = prefer === 'top' ? 'bottom' : 'top';
  const side = bubble.height <= room[prefer] ? prefer
    : bubble.height <= room[other] ? other
    : room[other] > room[prefer] ? other : prefer;
  const top = clampStart(
    side === 'top' ? trigger.top - FIXED_TIP_GAP - bubble.height : trigger.bottom + FIXED_TIP_GAP,
    FIXED_TIP_MARGIN,
    viewport.height - FIXED_TIP_MARGIN - bubble.height,
  );
  const left = clampStart(
    trigger.left + trigger.width / 2 - bubble.width / 2,
    FIXED_TIP_MARGIN,
    viewport.width - FIXED_TIP_MARGIN - bubble.width,
  );
  return { side, left, top };
}

/** `value` inside [lo, hi]. A bubble bigger than the viewport has no such range: its start edge stays on screen. */
function clampStart(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
