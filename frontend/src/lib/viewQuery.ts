/**
 * Turns a saved view's stored filter into the issue list route's query. The
 * list route takes one value per field, while a view may store several or
 * filter on things the list route cannot, so this keeps the closest query and
 * names what it had to leave out, letting the page say so rather than show a
 * wider list as if it were exact.
 */

import type { IssueListQuery, SavedViewRead, ViewFilter } from '../types/Api';

/** The filter fields the list route takes one value of. */
const SINGLE_FIELDS = [
  'team_id',
  'status_id',
  'assignee_id',
  'label_id',
  'parent_id',
  'cycle_id',
  'project_id',
] as const;

/** The first entry of a filter value, which is the whole value for a scalar. */
const firstOf = <T>(value: T | T[] | undefined): T | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Whether a filter value holds more than the list route can express. */
const isWide = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 1;

/**
 * Turns a stored filter into the list route's query, keeping the first value
 * of each field, which narrows rather than widens when the view stores more.
 */
export const viewQuery = (view: SavedViewRead): IssueListQuery => {
  const filter: ViewFilter = view.filter;
  const query: IssueListQuery = { sort: view.sort };
  for (const field of SINGLE_FIELDS) {
    const value = firstOf(filter[field]);
    if (value !== undefined && value !== '') query[field] = value;
  }
  const priority = firstOf(filter.priority);
  if (priority !== undefined) query.priority = priority;
  if (filter.q !== undefined && filter.q.trim() !== '') query.q = filter.q;
  return query;
};

/**
 * The parts of a stored filter the list route cannot apply, as sentences,
 * so the page can say what the shown list leaves out.
 */
export const unsupportedParts = (view: SavedViewRead): string[] => {
  const filter = view.filter;
  const parts: string[] = [];
  const wide = [...SINGLE_FIELDS, 'priority' as const].filter((field) =>
    isWide(filter[field])
  );
  if (wide.length > 0) {
    parts.push('only the first value of a filter with several is applied');
  }
  if (filter.status_category !== undefined) {
    parts.push('the status category filter is not applied');
  }
  if (filter.due_before !== undefined || filter.due_after !== undefined) {
    parts.push('the due date window is not applied');
  }
  if (view.group_by !== null) {
    parts.push('rows are not grouped');
  }
  return parts;
};
