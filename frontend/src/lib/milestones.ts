/**
 * Pure helpers over a project's milestones: the order they are listed in and
 * the key a milestone takes when it is dragged to a new place.
 */

import { orderBetween } from '../api/issues';
import type { MilestoneRead } from '../types/Api';

/** Orders milestones by their fractional key, the order the server lists them in. */
export const byMilestoneOrder = (
  left: MilestoneRead,
  right: MilestoneRead
): number =>
  left.sort_order < right.sort_order
    ? -1
    : left.sort_order > right.sort_order
      ? 1
      : 0;

/**
 * The key a milestone takes when it moves to `to` among the others, read off
 * the neighbours it lands between. Answers null when it would not move.
 */
export const reorderKey = (
  milestones: MilestoneRead[],
  from: number,
  to: number
): string | null => {
  if (from === to || to < 0 || to >= milestones.length) return null;
  const moving = milestones[from];
  if (moving === undefined) return null;
  const others = milestones.filter((_, index) => index !== from);
  const before = others[to - 1]?.sort_order ?? null;
  const after = others[to]?.sort_order ?? null;
  try {
    return orderBetween(before, after);
  } catch {
    return null;
  }
};
