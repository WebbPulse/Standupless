/**
 * The wording of a cycle's lifecycle confirms, and which cycle each action
 * applies to. Shared by the team cycles page and a cycle's own page so the
 * two confirms never drift apart.
 */

import { cycleTitle } from './cycleBreakdown';
import type { CycleRead } from '../types/Api';

/** How many issues starting a cycle today moves out of the current one. */
export const movingCount = (current: CycleRead | undefined): number =>
  current === undefined ? 0 : current.counts.todo + current.counts.in_progress;

/** The confirm sentence for starting a cycle today. */
export const startTodayMessage = (
  cycle: CycleRead,
  current: CycleRead | undefined
): string => {
  const title = cycleTitle(cycle);
  if (current === undefined) return `${title} will start today.`;
  const count = movingCount(current);
  const issues = count === 1 ? '1 open issue' : `${String(count)} open issues`;
  return `${title} will start today and ${cycleTitle(current)} will end yesterday. ${issues} will move from ${cycleTitle(current)} into ${title}.`;
};

/** The confirm sentence for ending the current cycle today. */
export const endTodayMessage = (cycle: CycleRead): string => {
  const count = movingCount(cycle);
  const issues =
    count === 0
      ? 'Any unfinished issues'
      : count === 1
        ? 'Its 1 unfinished issue'
        : `Its ${String(count)} unfinished issues`;
  return `${cycleTitle(cycle)} will end at the close of today. ${issues} will roll into the next cycle. This cannot be undone.`;
};

/** The confirm sentence for deleting a cycle. */
export const deleteCycleMessage = (cycle: CycleRead): string =>
  `${cycleTitle(cycle)} will be deleted. Its issues stay in the team and leave the cycle. This cannot be undone.`;

/** The team's running cycle and the upcoming one next in line. */
export interface CycleNeighbours {
  current: CycleRead | undefined;
  next: CycleRead | undefined;
}

/**
 * The team's running cycle and the upcoming one that would start today, read
 * from the team's own cycles in any order.
 */
export const cycleNeighbours = (cycles: CycleRead[]): CycleNeighbours => {
  const upcoming = cycles
    .filter((row) => row.status === 'upcoming')
    .sort((left, right) => left.start_date.localeCompare(right.start_date));
  return {
    current: cycles.find((row) => row.status === 'active'),
    next: upcoming[0],
  };
};
