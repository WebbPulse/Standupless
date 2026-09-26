/**
 * Keeping floating bits such as tooltips inside the window, so a bubble on a
 * control at the edge never widens the page into a horizontal scroll.
 */

/** The gap kept between an open bubble and the viewport's edge, in px. */
const EDGE_GAP_PX = 8;

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
