/**
 * The grouping, access and burn-up arithmetic the planning pages share. Kept
 * apart from the components so the pages export only components and so the
 * sums can be tested against fixed rows rather than a rendered chart.
 */

import type {
  CycleHistoryPoint,
  IssueRead,
  ProjectHistoryRead,
  ProjectProjectionRead,
  ProjectRead,
  ProjectStatus,
  StatusCategory,
  StatusRead,
  TeamRead,
  VelocityRead,
  WorkspaceRole,
} from '../types/Api';
import { estimatePoints } from './issueView';

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

/** What one issue adds to a progress sum. */
export type IssueWeigher = (issue: IssueRead) => number;

/** Weighs every issue as one, which is a sum in issues. */
export const countEach: IssueWeigher = () => 1;

/**
 * What one issue adds to a project's scope on its own team's scale, the way the
 * server's rollup weighs it: one on a team with estimates off, nothing or one for
 * an unestimated issue as the team counts them, and its points otherwise.
 */
export const issueWeight = (
  estimate: string | null,
  team:
    Pick<TeamRead, 'estimate_scale' | 'estimate_count_unestimated'> | undefined
): number => {
  if (team === undefined || team.estimate_scale === 'off') return 1;
  if (estimate === null || estimate.trim() === '') {
    return team.estimate_count_unestimated === true ? 1 : 0;
  }
  return estimatePoints(estimate);
};

/** Weighs each issue in points on the scale of the team that holds it. */
export const pointWeigher = (teams: readonly TeamRead[]): IssueWeigher => {
  const byId = new Map(teams.map((team) => [team.id, team]));
  return (issue) => issueWeight(issue.estimate, byId.get(issue.team_id));
};

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
  today: string,
  weigh: IssueWeigher = countEach
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
      const weight = weigh(issue);
      scope += weight;
      const changed = issue.updated_at.slice(0, 10) <= date;
      if (category === 'completed' && changed) {
        completed += weight;
        started += weight;
      } else if (category === 'started' && changed) {
        started += weight;
      }
    }
    return { date, scope, started, completed };
  });
};

/** The days a project's progress graph spans, first and last inclusive. */
export interface ProjectGraphRange {
  start: string;
  end: string;
}

/**
 * The days a project's progress graph spans. It opens on the start date, or
 * on the day the earliest issue or the project itself was created, and runs
 * to the target date when that is still ahead, otherwise to today. A project
 * that has not started yet has nothing to draw, so it gets `null`.
 */
export const projectGraphRange = (
  project: Pick<ProjectRead, 'start_date' | 'target_date' | 'created_at'>,
  issues: Pick<IssueRead, 'created_at'>[],
  today: string
): ProjectGraphRange | null => {
  const earliest = issues.reduce(
    (first, issue) =>
      issue.created_at.slice(0, 10) < first
        ? issue.created_at.slice(0, 10)
        : first,
    project.created_at.slice(0, 10)
  );
  const start = project.start_date ?? earliest;
  if (start > today) return null;
  const end =
    project.target_date !== null && project.target_date > today
      ? project.target_date
      : today;
  return { start, end };
};

/** How many of a list of issues fall in each status category. */
export const categoryCounts = (
  issues: IssueRead[],
  statuses: StatusRead[],
  weigh: IssueWeigher = countEach
): Record<StatusCategory, number> => {
  const counts: Record<StatusCategory, number> = {
    backlog: 0,
    unstarted: 0,
    started: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const issue of issues) {
    counts[categoryOf(issue, statuses) ?? 'backlog'] += weigh(issue);
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

/** How far past today a projected finish may stretch a project's graph. */
export const FORECAST_HORIZON_DAYS = 180;

/** The `YYYY-MM-DD` day `offset` days from `day`. */
const shiftDay = (day: string, offset: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86400000)
    .toISOString()
    .slice(0, 10);

/** The whole days from `from` to `to`, negative when `to` comes first. */
const dayGap = (from: string, to: string): number =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
  );

/** Where a projection line ends: a day of the graph and the completed work by then. */
export interface ProjectForecast {
  date: string;
  value: number;
}

/** A project's recorded progress graph, ready for the burn-up chart. */
export interface ProjectHistoryGraph {
  points: BurnUpPoint[];
  days: string[];
  forecast: ProjectForecast | null;
  /** The target date when it falls on a day the graph draws. */
  targetDate: string | null;
}

/**
 * The graph a project's recorded history draws, or `null` when there is no
 * history yet or its scope has been empty every day, so the panel falls back
 * to reading the issues. The days run from the first recorded day to today,
 * stretched to the target date and to the projected finish when either lies
 * within {@link FORECAST_HORIZON_DAYS} of today. The forecast extends the
 * recent completion rate from today to the projected finish, or to the last
 * day drawn when the finish lies past it, capped at the current scope.
 */
export const projectHistoryGraph = (
  history: ProjectHistoryRead
): ProjectHistoryGraph | null => {
  if (history.recorded_since === null) return null;
  const points = historySeries(history.days, history.measure);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;
  if (points.every((point) => point.scope === 0)) return null;
  const horizon = shiftDay(last.date, FORECAST_HORIZON_DAYS);
  const target = history.target_date;
  const expected = history.projection?.expected_date ?? null;
  let end = last.date;
  if (target !== null && target > end && target <= horizon) end = target;
  if (expected !== null && expected > end && expected <= horizon) {
    end = expected;
  }
  const rate = history.projection?.rate_per_day ?? 0;
  let forecast: ProjectForecast | null = null;
  if (rate > 0 && end > last.date) {
    const date = expected !== null && expected <= end ? expected : end;
    const reached = last.completed + rate * dayGap(last.date, date);
    forecast = {
      date,
      value: Math.min(last.scope, Math.round(reached * 10) / 10),
    };
  }
  return {
    points,
    days: daysBetween(first.date, end),
    forecast,
    targetDate:
      target !== null && target >= first.date && target <= end ? target : null,
  };
};

/** The words a projection reads as, and whether they say the project runs late. */
export interface ProjectionNote {
  text: string;
  late: boolean;
}

/** `n` days, singular for one. */
const dayCount = (value: number): string =>
  `${String(value)} ${value === 1 ? 'day' : 'days'}`;

/**
 * How a project's projected finish reads beside its graph: the expected date
 * and how far it lands from the target, or why there is no date to name.
 * `null` when there is no projection at all.
 */
export const projectionNote = (
  projection: ProjectProjectionRead | null,
  formatDay: (day: string) => string
): ProjectionNote | null => {
  if (projection === null) return null;
  if (projection.rate_per_day <= 0) {
    return {
      text: 'No work was completed in the last two weeks, so there is no projected finish yet.',
      late: false,
    };
  }
  if (projection.expected_date === null) {
    return {
      text: 'At the recent pace the remaining scope is more than ten years from done.',
      late: true,
    };
  }
  const finish = `Projected to finish ${formatDay(projection.expected_date)}`;
  const past = projection.days_past_target;
  if (past === null) return { text: `${finish}.`, late: false };
  if (past === 0)
    return { text: `${finish}, on the target date.`, late: false };
  if (past > 0) {
    return {
      text: `${finish}, ${dayCount(past)} after the target.`,
      late: true,
    };
  }
  return {
    text: `${finish}, ${dayCount(-past)} before the target.`,
    late: false,
  };
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
