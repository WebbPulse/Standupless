/**
 * A cycle's issues broken down by assignee, label and project: how many each
 * one holds and how many of those are done. Cancelled issues are left out, as
 * they are from the cycle's scope, so a row's share matches the header's.
 */

import { NONE } from '../api/issues';
import type { IssueRead, StatusRead } from '../types/Api';
import { labelGroupKey, type IssueContext } from './issueView';
import { personLabel } from './issuePeople';

/** The fields a cycle can be broken down by. */
export type BreakdownField = 'assignee' | 'label' | 'project';

/** One row of a breakdown: who or what, the issues it holds and those done. */
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
};

/** The ids an issue counts under for one field, `none` standing for unset. */
const idsOf = (issue: IssueRead, field: BreakdownField): string[] => {
  if (field === 'assignee') return [issue.assignee_id ?? NONE];
  if (field === 'project') return [issue.project_id ?? NONE];
  return issue.label_ids.length === 0 ? [NONE] : issue.label_ids;
};

/**
 * The rows of one breakdown, the largest first and the unset row last. Like
 * named labels across a rolled up cycle's teams share one row, filed under
 * the first label id met so a click filters by all of them.
 */
export const cycleBreakdown = (
  issues: readonly IssueRead[],
  statuses: readonly StatusRead[],
  field: BreakdownField,
  context: Pick<IssueContext, 'labels' | 'people' | 'projects'>
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
      row.total += 1;
      if (category === 'completed') row.completed += 1;
      if (category === 'completed' || category === 'started') row.started += 1;
    }
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
