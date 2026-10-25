/**
 * A cycle's or project's issues broken down by assignee, label, project and
 * priority: how much each one holds and how much of that is done, in issues or
 * weighed in points. Cancelled issues are left out, as they are from the
 * scope, so a row's share matches the header's.
 */

import { NONE } from '../api/issues';
import type { IssuePriority, IssueRead, StatusRead } from '../types/Api';
import { PRIORITY_LABELS } from './issueDisplay';
import { labelGroupKey, type IssueContext } from './issueView';
import { personLabel } from './issuePeople';

/** The fields a cycle can be broken down by. */
export type BreakdownField = 'assignee' | 'label' | 'project' | 'priority';

/** The priority rows in the order they show, worst first and unset last. */
export const PRIORITY_ORDER: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

/** What one issue adds to a row: one in issues, or its points. */
export type BreakdownWeigher = (issue: IssueRead) => number;

/** Weighs every issue as one, so a breakdown sums in issues. */
const ONE_EACH: BreakdownWeigher = () => 1;

/** One row of a breakdown: who or what, the amount it holds and the amount done. */
export interface BreakdownRow {
  /** The id the list filters on, or `none` for the unset row. */
  id: string;
  name: string;
  total: number;
  completed: number;
  started: number;
}

/** How each breakdown's unset row reads. */
const NONE_LABELS: Record<BreakdownField, string> = {
  assignee: 'No assignee',
  label: 'No label',
  project: 'No project',
  priority: PRIORITY_LABELS.none,
};

/** The ids an issue counts under for one field, `none` standing for unset. */
const idsOf = (issue: IssueRead, field: BreakdownField): string[] => {
  if (field === 'assignee') return [issue.assignee_id ?? NONE];
  if (field === 'project') return [issue.project_id ?? NONE];
  if (field === 'priority') return [issue.priority];
  return issue.label_ids.length === 0 ? [NONE] : issue.label_ids;
};

/**
 * The rows of one breakdown, the largest first and the unset row last, or by
 * priority from urgent down to no priority, with only the priorities held. Like
 * named labels across a rolled up cycle's teams share one row, filed under
 * the first label id met so a click filters by all of them. A weigher sums
 * the rows in points instead of issues.
 */
export const cycleBreakdown = (
  issues: readonly IssueRead[],
  statuses: readonly StatusRead[],
  field: BreakdownField,
  context: Pick<IssueContext, 'labels' | 'people' | 'projects'>,
  weigh: BreakdownWeigher = ONE_EACH
): BreakdownRow[] => {
  const categories = new Map(
    statuses.map((status) => [status.id, status.category])
  );
  const labelsById = new Map(context.labels.map((label) => [label.id, label]));
  const labelKeyOf = (id: string): string => {
    const label = labelsById.get(id);
    return label === undefined ? id : `label:${labelGroupKey(label)}`;
  };
  const rows = new Map<string, BreakdownRow>();
  const nameOf = (key: string, id: string): string => {
    if (key === NONE) return NONE_LABELS[field];
    if (field === 'assignee') {
      return personLabel(
        context.people.find((person) => person.user_id === id)
      );
    }
    if (field === 'priority') {
      return (PRIORITY_ORDER as readonly string[]).includes(id)
        ? PRIORITY_LABELS[id as IssuePriority]
        : 'Unknown priority';
    }
    if (field === 'project') {
      return (
        context.projects.find((project) => project.project_id === id)?.name ??
        'Unknown project'
      );
    }
    return labelsById.get(id)?.name ?? 'Unknown label';
  };
  for (const issue of issues) {
    const category = categories.get(issue.status_id) ?? 'backlog';
    if (category === 'cancelled') continue;
    const weight = weigh(issue);
    const seen = new Set<string>();
    for (const id of idsOf(issue, field)) {
      const key = field === 'label' && id !== NONE ? labelKeyOf(id) : id;
      if (seen.has(key)) continue;
      seen.add(key);
      let row = rows.get(key);
      if (row === undefined) {
        row = { id, name: nameOf(key, id), total: 0, completed: 0, started: 0 };
        rows.set(key, row);
      }
      row.total += weight;
      if (category === 'completed') row.completed += weight;
      if (category === 'completed' || category === 'started') {
        row.started += weight;
      }
    }
  }
  if (field === 'priority') {
    return PRIORITY_ORDER.flatMap((priority) => {
      const row = rows.get(priority);
      return row === undefined ? [] : [row];
    });
  }
  return [...rows.values()].sort(
    (left, right) =>
      Number(left.id === NONE) - Number(right.id === NONE) ||
      right.total - left.total ||
      left.name.localeCompare(right.name)
  );
};

/** A row's done share as a whole percent. */
export const breakdownPercent = (row: BreakdownRow): number =>
  row.total === 0 ? 0 : Math.round((row.completed / row.total) * 100);

/**
 * How a cycle reads as a title. A scheduled cycle is "Cycle N"; a name left
 * as the generated `auto-YYYYMMDD` slug reads as its number, or else as the
 * week it starts, so the raw slug never shows.
 */
export const cycleTitle = (cycle: {
  name: string;
  number?: number | null;
  start_date: string;
}): string => {
  const name = cycle.name.trim();
  if (name !== '' && !/^auto-\d{8}$/.test(name)) return name;
  if (cycle.number !== undefined && cycle.number !== null) {
    return `Cycle ${String(cycle.number)}`;
  }
  const day = Date.parse(`${cycle.start_date}T00:00:00Z`);
  if (Number.isNaN(day)) return 'Cycle';
  const label = new Date(day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return `Cycle of ${label}`;
};
