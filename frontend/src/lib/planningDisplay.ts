/**
 * How a cycle, a project and their rollup counts read in the interface. Kept
 * apart from the components so a component file exports only components and
 * stays refresh safe, and so the wording lives in one place rather than in each
 * page that renders a status pill.
 */

import type {
  CycleStatus,
  InitiativeStatus,
  ProjectRead,
  ProjectStatus,
  ProjectUpdateDueState,
  ProjectUpdateInterval,
  RollupCounts,
} from '../types/Api';

/** The initiative statuses, in the order a picker offers them. */
export const INITIATIVE_STATUSES: InitiativeStatus[] = [
  'planned',
  'active',
  'completed',
];

/** How each initiative status reads. */
export const INITIATIVE_STATUS_LABELS: Record<InitiativeStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  completed: 'Completed',
};

/** The project status glyph each initiative status draws with. */
export const INITIATIVE_STATUS_GLYPHS: Record<InitiativeStatus, ProjectStatus> =
  {
    planned: 'planned',
    active: 'in_progress',
    completed: 'completed',
  };

/** The cycle statuses, in the order a filter offers them. */
export const CYCLE_STATUSES: CycleStatus[] = [
  'upcoming',
  'active',
  'completed',
  'cancelled',
];

/** How a cycle status reads. */
export const CYCLE_STATUS_LABELS: Record<CycleStatus, string> = {
  upcoming: 'Upcoming',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** The project statuses, in the order a filter offers them. */
export const PROJECT_STATUSES: ProjectStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'paused',
  'completed',
  'canceled',
];

/** How a project status reads. */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  in_progress: 'In progress',
  paused: 'Paused',
  completed: 'Completed',
  canceled: 'Canceled',
};

/**
 * How a planning row's counts read as one line. Cancelled issues are named
 * only when there are some, because a zero there is noise on every other row.
 */
export const countsLabel = (counts: RollupCounts): string => {
  if (counts.total === 0) return 'No issues';
  const parts = [
    `${String(counts.done)} done`,
    `${String(counts.in_progress)} in progress`,
    `${String(counts.todo)} to do`,
  ];
  if (counts.cancelled > 0) parts.push(`${String(counts.cancelled)} cancelled`);
  return `${String(counts.total)} issues: ${parts.join(', ')}`;
};

/**
 * How far through its issues a planning row is, as a whole percent. Cancelled
 * issues are left out of the denominator, because work that was called off is
 * not work outstanding and counting it would pin a finished cycle below 100.
 */
export const completionPercent = (counts: RollupCounts): number => {
  const live = counts.total - counts.cancelled;
  if (live <= 0) return 0;
  return Math.round((counts.done / live) * 100);
};

/** The unit a project's, milestone's or initiative's progress reads in. */
export type ProgressMeasure = 'points' | 'issues';

/** A planning row that reports its progress in a measure beside its issue counts. */
export interface MeasuredProgress {
  counts: RollupCounts;
  measure?: ProgressMeasure;
  progress?: RollupCounts;
}

/**
 * Whether a row's progress reads in estimate points or issues. Points only when
 * the server says a team on the work estimates and sent the weighted buckets.
 */
export const progressMeasureOf = (row: MeasuredProgress): ProgressMeasure =>
  row.measure === 'points' && row.progress !== undefined ? 'points' : 'issues';

/** The buckets a row's scope and completion are measured by, in its measure. */
export const progressOf = (row: MeasuredProgress): RollupCounts =>
  progressMeasureOf(row) === 'points' && row.progress !== undefined
    ? row.progress
    : row.counts;

/** How far through its scope a row is, as a whole percent in its own measure. */
export const progressPercent = (row: MeasuredProgress): number =>
  completionPercent(progressOf(row));

/** The unit word for an amount in one measure, singular for exactly one. */
export const measureUnit = (
  measure: ProgressMeasure,
  value: number
): string => {
  if (measure === 'points') return value === 1 ? 'point' : 'points';
  return value === 1 ? 'issue' : 'issues';
};

/** How much of a row's scope is done, as "3 of 8 points" or "2 of 5 issues". */
export const progressLabel = (row: MeasuredProgress): string => {
  const progress = progressOf(row);
  const scope = progress.total - progress.cancelled;
  return `${String(progress.done)} of ${String(scope)} ${measureUnit(progressMeasureOf(row), scope)}`;
};

/** How far along a milestone's glyph draws it: no issues, none done, some done, or all done. */
export type MilestoneGlyphState = 'none' | 'empty' | 'partial' | 'complete';

/**
 * A milestone as any surface holds it: a full milestone row, or a timeline
 * marker that may come from a server too old to send its counts.
 */
export interface MilestoneProgressSource {
  name: string;
  counts?: RollupCounts;
  measure?: ProgressMeasure;
  progress?: RollupCounts;
  completed?: boolean;
}

/** A milestone's glyph state, its whole percent and the sentence it reads as. */
export interface MilestoneProgress {
  state: MilestoneGlyphState;
  percent: number;
  label: string;
}

/**
 * How far through its scope a milestone is, in the project's measure. A
 * partial milestone never rounds to 0 or 100, so the glyph only reads as
 * empty or complete when it is.
 */
export const milestoneProgress = (
  milestone: MilestoneProgressSource
): MilestoneProgress => {
  if (milestone.counts === undefined) {
    const done = milestone.completed === true;
    return {
      state: done ? 'complete' : 'empty',
      percent: done ? 100 : 0,
      label: `${milestone.name}, ${done ? '100' : '0'}% complete`,
    };
  }
  const row: MeasuredProgress = {
    counts: milestone.counts,
    ...(milestone.measure === undefined ? {} : { measure: milestone.measure }),
    ...(milestone.progress === undefined
      ? {}
      : { progress: milestone.progress }),
  };
  const progress = progressOf(row);
  const scope = progress.total - progress.cancelled;
  const unit = measureUnit(progressMeasureOf(row), scope);
  let state: MilestoneGlyphState;
  let percent: number;
  if (scope <= 0) {
    state = 'none';
    percent = 0;
  } else if (progress.done >= scope) {
    state = 'complete';
    percent = 100;
  } else if (progress.done <= 0) {
    state = 'empty';
    percent = 0;
  } else {
    state = 'partial';
    percent = Math.min(99, Math.max(1, progressPercent(row)));
  }
  return {
    state,
    percent,
    label: `${milestone.name}, ${String(percent)}% of ${String(Math.max(0, scope))} ${unit} complete`,
  };
};

/** How a nullable date reads, with an explicit word where there is none. */
export const dateLabel = (value: string | null, absent: string): string =>
  value === null || value === '' ? absent : value;

/** How a cycle's two dates read together. */
export const cycleDatesLabel = (startDate: string, endDate: string): string =>
  `${startDate} to ${endDate}`;

/**
 * Whole days from today until a date, negative once it is past. Read off the
 * calendar date rather than a timestamp difference so a cycle that ends today
 * reads as zero days left all day, not as a fraction that flips at noon.
 */
export const daysUntil = (value: string, today = new Date()): number => {
  const target = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(target)) return 0;
  const start = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  return Math.round((target - start) / 86400000);
};

/**
 * How long an active cycle has left, as a phrase. Past dates read as overdue
 * rather than as a negative count, because a person reads the urgency, not the
 * arithmetic.
 */
export const daysRemainingLabel = (
  endDate: string,
  today = new Date()
): string => {
  const days = daysUntil(endDate, today);
  if (days < 0) return `${String(Math.abs(days))} days over`;
  if (days === 0) return 'Ends today';
  if (days === 1) return '1 day left';
  return `${String(days)} days left`;
};

/** How a rollup reads in the short form a progress bar sits beside. */
export const shortCountsLabel = (counts: RollupCounts): string => {
  if (counts.total === 0) return 'No issues';
  const live = counts.total - counts.cancelled;
  return `${String(counts.done)} of ${String(live)}`;
};

/** How long a live project may go without an update before the page nudges. */
export const UPDATE_STALE_DAYS = 14;

/** The statuses a project is expected to report on. */
const REPORTING_STATUSES: ProjectStatus[] = ['planned', 'in_progress'];

/** The update cadences a project or a workspace offers, in menu order. */
export const PROJECT_UPDATE_INTERVALS: ProjectUpdateInterval[] = [7, 14, 30, 0];

/** How each update cadence reads. */
export const PROJECT_UPDATE_INTERVAL_LABELS: Record<
  ProjectUpdateInterval,
  string
> = {
  0: 'Off',
  7: 'Weekly',
  14: 'Every 2 weeks',
  30: 'Monthly',
};

/** How a due or overdue update reads as a badge; an upcoming one shows none. */
export const updateDueLabel = (
  state: ProjectUpdateDueState | null | undefined
): string | null => {
  if (state === 'overdue') return 'Update overdue';
  if (state === 'due') return 'Update due';
  return null;
};

/**
 * The nudge a project page shows: "Update due" or "Update overdue" once the
 * cadence the server computes says so, "No updates yet" on a live project
 * before its first, and, from a server that predates cadences, "No update in
 * 2 weeks" once the latest is older than that.
 */
export const updateNudge = (
  project: Pick<ProjectRead, 'status' | 'last_update_at' | 'update_due_state'>,
  now = new Date()
): string | null => {
  const due = updateDueLabel(project.update_due_state);
  if (due !== null) return due;
  if (!REPORTING_STATUSES.includes(project.status)) return null;
  const last = project.last_update_at ?? null;
  if (last === null) return 'No updates yet';
  if (project.update_due_state !== undefined) return null;
  const age = now.getTime() - new Date(last).getTime();
  if (Number.isNaN(age)) return null;
  return age > UPDATE_STALE_DAYS * 24 * 60 * 60 * 1000
    ? 'No update in 2 weeks'
    : null;
};
