/**
 * Conversions between the board's filter state and the filter a saved view
 * stores. They live beside the query keys rather than in the board page because
 * a view saved by one surface is read back by another, and a conversion that
 * sat in a page would tie the stored shape to whichever page happened to own it.
 */

import type { BoardKeyFilters } from './queryKeys';
import type { IssuePriority, ViewFilter } from '../types/Api';

/**
 * Turns the board's filter state into what a saved view stores. Only the keys
 * a person actually set are written, so a stored view does not pin a value the
 * board was never filtering on.
 */
export const toViewFilter = (filters: BoardKeyFilters): ViewFilter => ({
  ...(filters.assigneeId === '' ? {} : { assignee_id: filters.assigneeId }),
  ...(filters.labelId === '' ? {} : { label_id: filters.labelId }),
  ...(filters.priority === ''
    ? {}
    : { priority: filters.priority as IssuePriority }),
});

/**
 * Narrows a stored filter value to the single one the board reads under. The
 * contract lets a view store a list, which the issue list can express and the
 * board's one-value-per-control filter bar cannot, so the first entry is taken
 * rather than dropping the filter and showing more than the view asked for.
 */
const firstOf = (value: string | string[] | undefined): string => {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value[0] ?? '';
  return value;
};

/**
 * Reads a stored filter back into the board's state, ignoring the keys the
 * board does not filter on rather than failing on a view saved by a list.
 */
export const fromViewFilter = (filter: ViewFilter): BoardKeyFilters => ({
  assigneeId: firstOf(filter.assignee_id),
  labelId: firstOf(filter.label_id),
  priority: firstOf(filter.priority),
});
