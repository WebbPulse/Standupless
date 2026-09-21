/**
 * How a cycle, a project and their rollup counts read in the interface. Kept
 * apart from the components so a component file exports only components and
 * stays refresh safe, and so the wording lives in one place rather than in each
 * page that renders a status pill.
 */

import type { CycleStatus, ProjectStatus, RollupCounts } from '../types/Api';

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
  'planned',
  'in_progress',
  'done',
];

/** How a project status reads. */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  done: 'Done',
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

/** How a nullable date reads, with an explicit word where there is none. */
export const dateLabel = (value: string | null, absent: string): string =>
  value === null || value === '' ? absent : value;

/** How a cycle's two dates read together. */
export const cycleDatesLabel = (startDate: string, endDate: string): string =>
  `${startDate} to ${endDate}`;
