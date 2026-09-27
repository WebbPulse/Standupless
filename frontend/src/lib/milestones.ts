/**
 * Pure helpers over a project's milestones: the order they are listed in, the
 * key a milestone takes when it is dragged to a new place, and the patch that
 * moves an issue between projects without leaving a stale milestone on it.
 */

import { orderBetween } from '../api/issues';
import type { IssueRead, IssueUpdate, MilestoneRead } from '../types/Api';

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

/**
 * The patch a project pick becomes. A milestone belongs to one project, so
 * moving the issue clears it in the same write, which the server would do
 * anyway, and the optimistic copy then never shows a milestone of the project
 * the issue just left.
 */
export const projectPatch = (
  issue: IssueRead,
  projectId: string | null
): IssueUpdate =>
  (issue.project_milestone_id ?? null) !== null &&
  projectId !== issue.project_id
    ? { project_id: projectId, project_milestone_id: null }
    : { project_id: projectId };
