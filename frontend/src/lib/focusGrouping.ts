/**
 * The Focus grouping of My issues > Assigned, after Linear's: it answers
 * "what should I work on next" by sorting the caller's issues into sections
 * from the most pressing to the least, each issue under the first section it
 * qualifies for. It is computed on the client from fields every list row
 * carries, and it is never stored, since a saved view or a team default has
 * no Focus grouping to restore.
 */

import type {
  CycleRead,
  IssuePriority,
  IssueRead,
  StatusCategory,
} from '../types/Api';
import { liveSlaStatus, slaPaused } from './sla';

/** The grouping field Focus goes by in a view state and the URL. */
export const FOCUS_FIELD = 'focus';

/** Why a Focus grouped list cannot be saved as a view. */
export const FOCUS_SAVE_REFUSED =
  'Focus grouping only works on My issues. Pick another grouping to save this as a view.';

/** One section of the Focus grouping. */
export type FocusSection =
  | 'urgent'
  | 'sla'
  | 'blockers'
  | 'cycle'
  | 'active'
  | 'triage'
  | 'backlog'
  | 'completed';

/** The sections in the order they show, the most pressing first. */
export const FOCUS_SECTIONS: readonly FocusSection[] = [
  'urgent',
  'sla',
  'blockers',
  'cycle',
  'active',
  'triage',
  'backlog',
  'completed',
];

/** How each section heads its group. */
export const FOCUS_SECTION_LABELS: Record<FocusSection, string> = {
  urgent: 'Urgent',
  sla: 'SLA',
  blockers: 'Blockers',
  cycle: 'Cycle work',
  active: 'Other active work',
  triage: 'Triage',
  backlog: 'Backlog',
  completed: 'Completed',
};

/** The issue fields the section assignment reads. */
export type FocusIssue = Pick<
  IssueRead,
  | 'priority'
  | 'cycle_id'
  | 'in_triage'
  | 'blocking_count'
  | 'sla_status'
  | 'sla_started_at'
  | 'sla_breaches_at'
  | 'sla_paused_at'
>;

/**
 * The ids of the cycles running now, each team's current one, which the
 * Cycle work section matches an issue's cycle against.
 */
export const currentCycleIds = (
  cycles: readonly CycleRead[]
): ReadonlySet<string> =>
  new Set(
    cycles
      .filter((cycle) => cycle.status === 'active' && !cycle.cancelled)
      .map((cycle) => cycle.cycle_id)
  );

const isClosed = (category: StatusCategory | undefined): boolean =>
  category === 'completed' || category === 'cancelled';

/**
 * Whether an issue's SLA puts it in the SLA section: at risk or breached, or
 * a timer still running toward its deadline.
 */
const slaBound = (issue: FocusIssue, now: Date): boolean => {
  const status = liveSlaStatus(issue, now);
  if (status === 'at_risk' || status === 'breached') return true;
  return status === 'on_track' && !slaPaused(issue);
};

/**
 * The section an issue lands in: the first it qualifies for, in section
 * order. `category` is the category of the status the issue sits in, or
 * undefined when the lists do not hold it, which reads as open, unstarted
 * work. Closed issues only ever land in Completed.
 */
export const focusSectionOf = (
  issue: FocusIssue,
  category: StatusCategory | undefined,
  currentCycles: ReadonlySet<string>,
  now: Date = new Date()
): FocusSection => {
  if (isClosed(category)) return 'completed';
  const triage = issue.in_triage === true;
  if (issue.priority === 'urgent' && !triage) return 'urgent';
  if (slaBound(issue, now)) return 'sla';
  if ((issue.blocking_count ?? 0) > 0) return 'blockers';
  if (issue.cycle_id !== null && currentCycles.has(issue.cycle_id)) {
    return 'cycle';
  }
  if (triage) return 'triage';
  if (category === 'backlog') return 'backlog';
  return 'active';
};

const PRIORITY_RANK: Record<IssuePriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

/**
 * Orders one section's rows: started issues first, then by priority from
 * urgent to none, with the rows' incoming order breaking every tie.
 */
export const orderWithinFocus = <T extends Pick<IssueRead, 'priority'>>(
  issues: readonly T[],
  categoryOf: (issue: T) => StatusCategory | undefined
): T[] =>
  issues
    .map((issue, index) => ({
      issue,
      index,
      started: categoryOf(issue) === 'started' ? 0 : 1,
    }))
    .sort(
      (left, right) =>
        left.started - right.started ||
        PRIORITY_RANK[left.issue.priority] -
          PRIORITY_RANK[right.issue.priority] ||
        left.index - right.index
    )
    .map((entry) => entry.issue);
