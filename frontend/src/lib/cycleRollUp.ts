/**
 * Rolling a parent team's cycles up with its sub-teams'. A sub-team runs on
 * its parent's cycle schedule, so the sub-team's cycle with the same start
 * and end dates is the same time box, and the parent's cycle pages count its
 * issues too. Sub-team cycles with no matching parent cycle stay on the
 * sub-team's own pages.
 */

import { listCycles } from '../api/planning';
import type {
  CarryOver,
  CycleHistoryPoint,
  CycleListRead,
  CycleRead,
  RollupCounts,
} from '../types/Api';

/** How many cycles one page of the rolled up list asks for, the most the route allows. */
const ROLL_UP_PAGE_SIZE = 100;

/**
 * A parent team's cycles with its visible sub-teams' rolled in, read to the
 * end of the cursor, since the merged list pages by offset over every team's
 * cycles and the newest sit last. Stops on a repeated cursor rather than
 * looping on it.
 */
export const readRolledUpCycles = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<CycleRead[]> => {
  const rows: CycleRead[] = [];
  let cursor: string | null = null;
  do {
    const page: CycleListRead = await listCycles(
      workspaceId,
      {
        team_id: teamId,
        include_sub_teams: true,
        limit: ROLL_UP_PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      signal
    );
    rows.push(...page.cycles);
    if (page.next_cursor !== null && page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  } while (cursor !== null);
  return rows;
};

/** Whether two cycles cover the same days. */
const sameDates = (left: CycleRead, right: CycleRead): boolean =>
  left.start_date === right.start_date && left.end_date === right.end_date;

/**
 * The cycles in `rows` of the teams in `subTeamIds` that share `cycle`'s
 * dates, which are the sub-teams' share of it.
 */
export const matchingCycles = (
  cycle: CycleRead,
  rows: CycleRead[],
  subTeamIds: string[]
): CycleRead[] =>
  rows.filter(
    (row) =>
      row.cycle_id !== cycle.cycle_id &&
      subTeamIds.includes(row.team_id) &&
      sameDates(row, cycle)
  );

/** Two sets of rollup buckets added together. */
const addCounts = (left: RollupCounts, right: RollupCounts): RollupCounts => ({
  todo: left.todo + right.todo,
  in_progress: left.in_progress + right.in_progress,
  done: left.done + right.done,
  cancelled: left.cancelled + right.cancelled,
  total: left.total + right.total,
});

/** Two optional sets of buckets added, absent only when both are. */
const addOptional = (
  left: RollupCounts | undefined,
  right: RollupCounts | undefined
): RollupCounts | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return addCounts(left, right);
};

/** Two carry-overs added, keeping only the totals the page reads. */
const addCarry = (
  left: CarryOver | undefined,
  right: CarryOver | undefined
): CarryOver | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return {
    carried_in: left.carried_in + right.carried_in,
    carried_in_points: left.carried_in_points + right.carried_in_points,
    carried_out: left.carried_out + right.carried_out,
    carried_out_points: left.carried_out_points + right.carried_out_points,
  };
};

/**
 * `cycle` with the counts, points and carry-over of `others` added, so its
 * header and progress cover the sub-teams' issues too.
 */
export const mergeCycles = (cycle: CycleRead, others: CycleRead[]): CycleRead =>
  others.reduce<CycleRead>((held, other) => {
    const points = addOptional(held.points, other.points);
    const unestimated = addOptional(held.unestimated, other.unestimated);
    const carry = addCarry(held.carry, other.carry);
    return {
      ...held,
      counts: addCounts(held.counts, other.counts),
      ...(points === undefined ? {} : { points }),
      ...(unestimated === undefined ? {} : { unestimated }),
      ...(carry === undefined ? {} : { carry }),
    };
  }, cycle);

/**
 * A parent team's cycles from a list that rolls in its sub-teams': each of
 * the team's own cycles with its sub-teams' matching cycles merged into it.
 */
export const rollUpCycles = (
  teamId: string,
  rows: CycleRead[],
  subTeamIds: string[]
): CycleRead[] =>
  rows
    .filter((row) => row.team_id === teamId)
    .map((row) => mergeCycles(row, matchingCycles(row, rows, subTeamIds)));

/** Several cycles' daily histories added day by day, in date order. */
export const mergeHistories = (
  histories: CycleHistoryPoint[][]
): CycleHistoryPoint[] => {
  const byDate = new Map<string, CycleHistoryPoint>();
  for (const days of histories) {
    for (const day of days) {
      const held = byDate.get(day.date);
      byDate.set(
        day.date,
        held === undefined
          ? { ...day }
          : {
              date: day.date,
              scope: held.scope + day.scope,
              started: held.started + day.started,
              completed: held.completed + day.completed,
              scope_points: held.scope_points + day.scope_points,
              started_points: held.started_points + day.started_points,
              completed_points: held.completed_points + day.completed_points,
            }
      );
    }
  }
  return [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date)
  );
};
