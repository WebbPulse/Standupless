/**
 * The grouping, access and burn-up arithmetic the planning pages share. Kept
 * apart from the components so the pages export only components and so the
 * sums can be tested against fixed rows rather than a rendered chart.
 */

import type {
  CycleHistoryPoint,
  IssueRead,
  ProjectRead,
  ProjectStatus,
  StatusCategory,
  StatusRead,
  TeamRead,
  VelocityRead,
  WorkspaceRole,
} from '../types/Api';

/** The order project status groups run in on the projects list. */
export const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  'in_progress',
  'planned',
  'paused',
  'backlog',
  'completed',
  'canceled',
];

/** The order issue status groups run in on a project or cycle list. */
export const ISSUE_GROUP_ORDER: StatusCategory[] = [
  'started',
  'unstarted',
  'backlog',
  'completed',
  'cancelled',
];

/** How an issue status group reads as a heading. */
export const ISSUE_GROUP_LABELS: Record<StatusCategory, string> = {
  started: 'In progress',
  unstarted: 'Todo',
  backlog: 'Backlog',
  completed: 'Done',
  cancelled: 'Canceled',
};

/** One named group of rows. */
export interface Group<K, T> {
  key: K;
  rows: T[];
}

/**
 * Groups projects by status in the list's order, leaving out the statuses
 * with no projects.
 */
export const groupProjectsByStatus = (
  projects: ProjectRead[]
): Group<ProjectStatus, ProjectRead>[] =>
  PROJECT_STATUS_ORDER.map((key) => ({
    key,
    rows: projects.filter((project) => project.status === key),
  })).filter((group) => group.rows.length > 0);

/** The category each issue's status falls in, looked up across teams. */
export const categoryOf = (
  issue: IssueRead,
  statuses: StatusRead[]
): StatusCategory | undefined =>
  statuses.find((status) => status.id === issue.status_id)?.category;

/**
 * Groups issues by status category in the list's order. An issue whose status
 * is not known yet sits with the backlog rather than vanishing.
 */
export const groupIssuesByCategory = (
  issues: IssueRead[],
  statuses: StatusRead[]
): Group<StatusCategory, IssueRead>[] =>
  ISSUE_GROUP_ORDER.map((key) => ({
    key,
    rows: issues.filter(
      (issue) => (categoryOf(issue, statuses) ?? 'backlog') === key
    ),
  })).filter((group) => group.rows.length > 0);

/**
 * Whether the caller may edit a project: a workspace owner, admin or member,
 * or someone holding a role on one of its teams. The server decides; this
 * only chooses what the page offers.
 */
export const canEditProject = (
  workspaceRole: WorkspaceRole | undefined,
  project: Pick<ProjectRead, 'team_ids'>,
  teams: TeamRead[]
): boolean =>
  workspaceRole === 'owner' ||
  workspaceRole === 'admin' ||
  workspaceRole === 'member' ||
  teams.some(
    (team) => project.team_ids.includes(team.id) && team.role !== undefined
  );

/** One day of a burn-up chart. */
export interface BurnUpPoint {
  date: string;
  scope: number;
  started: number;
  completed: number;
}

/** The whole days from `start` to `end`, both inclusive, as `YYYY-MM-DD`. */
export const daysBetween = (start: string, end: string): string[] => {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return [];
  const days: string[] = [];
  for (let time = from; time <= to; time += 86400000) {
    days.push(new Date(time).toISOString().slice(0, 10));
  }
  return days;
};

/**
 * A burn-up series over a cycle's days, up to and including `today`.
 *
 * The API keeps no history of a cycle's scope or of when an issue changed
 * status, so this is read off the issues as they are now: an issue joins the
 * scope on the day it was created, or on the first day if it predates the
 * cycle, and counts as started or completed from its last update when its
 * status sits in that category. Cancelled issues are out of scope.
 */
export const burnUpSeries = (
  issues: IssueRead[],
  statuses: StatusRead[],
  startDate: string,
  endDate: string,
  today: string
): BurnUpPoint[] => {
  const last = today < endDate ? today : endDate;
  const live = issues
    .map((issue) => ({ issue, category: categoryOf(issue, statuses) }))
    .filter((row) => row.category !== 'cancelled');
  return daysBetween(startDate, last).map((date) => {
    let scope = 0;
    let started = 0;
    let completed = 0;
    for (const { issue, category } of live) {
      if (issue.created_at.slice(0, 10) > date) continue;
      scope += 1;
      const changed = issue.updated_at.slice(0, 10) <= date;
      if (category === 'completed' && changed) {
        completed += 1;
        started += 1;
      } else if (category === 'started' && changed) {
        started += 1;
      }
    }
    return { date, scope, started, completed };
  });
};

/** How many of a list of issues fall in each status category. */
export const categoryCounts = (
  issues: IssueRead[],
  statuses: StatusRead[]
): Record<StatusCategory, number> => {
  const counts: Record<StatusCategory, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const issue of issues) {
    counts[categoryOf(issue, statuses) ?? 'backlog'] += 1;
  }
  return counts;
};

/** Which measure a burn-up or velocity reads in. */
export type PlanningMeasure = 'issues' | 'points';

/** How many recorded days a projection needs before it is worth drawing. */
export const MIN_PROJECTION_DAYS = 3;

/** A cycle's recorded history as burn-up points in one measure. */
export const historySeries = (
  days: CycleHistoryPoint[],
  measure: PlanningMeasure
): BurnUpPoint[] =>
  days.map((day) =>
    measure === 'points'
      ? {
          date: day.date,
          scope: day.scope_points,
          started: day.started_points,
          completed: day.completed_points,
        }
      : {
          date: day.date,
          scope: day.scope,
          started: day.started,
          completed: day.completed,
        }
  );

/**
 * Where completed work lands on the cycle's last day if the pace so far
 * holds, capped at the current scope, or `null` when there is too little to
 * go on: fewer than three days recorded, nothing completed yet, or no days
 * left to project over.
 */
export const projectCompletion = (
  points: BurnUpPoint[],
  dayCount: number
): number | null => {
  const last = points[points.length - 1];
  if (last === undefined) return null;
  if (points.length < MIN_PROJECTION_DAYS || points.length >= dayCount) {
    return null;
  }
  if (last.completed <= 0 || last.scope <= 0) return null;
  const perDay = last.completed / points.length;
  const projected = last.completed + perDay * (dayCount - points.length);
  return Math.min(last.scope, Math.round(projected * 10) / 10);
};

/** How a projection reads in words beside the chart. */
export const projectionLabel = (
  projected: number,
  scope: number,
  measure: PlanningMeasure
): string => {
  if (projected >= scope) return 'On pace to finish the scope';
  const unit = measure === 'points' ? 'points' : 'issues';
  return `On pace for ${String(Math.round(projected))} of ${String(scope)} ${unit}`;
};

/**
 * Whether a team's velocity reads in points: only when the team estimates
 * and at least one closed cycle carried estimated work, since a scale
 * switched on yesterday has no history to average.
 */
export const velocityMeasure = (velocity: VelocityRead): PlanningMeasure =>
  velocity.estimate_scale !== 'off' &&
  velocity.cycles.some((cycle) => cycle.scope_points > 0)
    ? 'points'
    : 'issues';

/** Capacity guidance for the cycle being planned, in one measure. */
export interface CapacityGuidance {
  measure: PlanningMeasure;
  average: number;
  planned: number;
  carriedIn: number;
  /** Planned less the average: above zero is over what the team usually finishes. */
  delta: number;
}

/**
 * How the planned cycle's scope compares with the team's average velocity,
 * or `null` when there is no cycle to plan or no closed cycle to compare with.
 * Reads in the team's natural measure unless one is asked for.
 */
export const capacityGuidance = (
  velocity: VelocityRead,
  measure: PlanningMeasure = velocityMeasure(velocity)
): CapacityGuidance | null => {
  const upcoming = velocity.upcoming;
  if (upcoming === null || velocity.cycles.length === 0) return null;
  const average =
    measure === 'points' ? velocity.average_points : velocity.average_issues;
  const planned =
    measure === 'points' ? upcoming.scope_points : upcoming.scope_issues;
  const carriedIn =
    measure === 'points' ? upcoming.carried_in_points : upcoming.carried_in;
  return {
    measure,
    average,
    planned,
    carriedIn,
    delta: Math.round((planned - average) * 10) / 10,
  };
};
