/**
 * Keeping floating bits such as tooltips inside the window, so a bubble on a
 * control at the edge never widens the page into a horizontal scroll.
 */

/** The gap kept between an open bubble and the viewport's edge, in px. */
const EDGE_GAP_PX = 8;

/** The gap kept between an open bubble and its control, in px. */
const BUBBLE_GAP_PX = 6;

/** How far a bubble spanning `left` to `right` must move to fit `width`. */
export const shiftIntoView = (
  left: number,
  right: number,
  width: number
): number => {
  if (right > width - EDGE_GAP_PX)
    return Math.max(width - EDGE_GAP_PX - right, EDGE_GAP_PX - left);
  if (left < EDGE_GAP_PX) return EDGE_GAP_PX - left;
  return 0;
};

/**
 * The top of a bubble `size` tall placed beside a control spanning `start` to
 * `end`, on the preferred side when it fits within `limit` and on the other
 * side when only that one does, clamped inside the viewport either way.
 */
export const placeBeside = (
  start: number,
  end: number,
  size: number,
  limit: number,
  side: 'top' | 'bottom'
): number => {
  const below = end + BUBBLE_GAP_PX;
  const above = start - BUBBLE_GAP_PX - size;
  const fitsBelow = below + size <= limit - EDGE_GAP_PX;
  const fitsAbove = above >= EDGE_GAP_PX;
  const top =
    side === 'bottom'
      ? fitsBelow || !fitsAbove
        ? below
        : above
      : fitsAbove || !fitsBelow
        ? above
        : below;
  return Math.max(EDGE_GAP_PX, Math.min(top, limit - EDGE_GAP_PX - size));
};
