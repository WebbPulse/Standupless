/**
 * Where a card dragged on the board would land, kept apart from the board so
 * the rule for drawing its placeholder can be tested without a drag.
 */

/**
 * Whether a drop at `target` would leave the card where it already sits:
 * the same cell, just above or just below itself. No placeholder is drawn
 * there, since the dimmed card already marks that spot.
 */
export const isNoOpDrop = (
  source: { lane: string; column: string; from: number },
  target: { lane: string; column: string; index: number }
): boolean =>
  source.from >= 0 &&
  source.lane === target.lane &&
  source.column === target.column &&
  (target.index === source.from || target.index === source.from + 1);
