/**
 * The grouping, access and burn-up arithmetic the planning pages share. Kept
 * apart from the components so the pages export only components and so the
 * sums can be tested against fixed rows rather than a rendered chart.
 */

import type {
  IssueRead,
  ProjectRead,
  ProjectStatus,
  StatusCategory,
  StatusRead,
  TeamRead,
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
