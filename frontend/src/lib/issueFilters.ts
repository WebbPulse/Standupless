/**
 * The filter values an issue list reads from, and how they turn into the query
 * the list route takes. Kept out of the component so a page can hold the values
 * without importing a component, and so the blanks are dropped in one place.
 */

import type { IssuePriority, IssueSort } from '../types/Api';

/** The filter values an issue list reads from. */
export interface FilterState {
  statusId: string;
  assigneeId: string;
  labelId: string;
  priority: string;
  q: string;
  sort: IssueSort;
}

/** The filters a list starts on: nothing filtered, the route's default sort. */
export const emptyFilters: FilterState = {
  statusId: '',
  assigneeId: '',
  labelId: '',
  priority: '',
  q: '',
  sort: 'updated_desc',
};

/** The part of a list query the filter bar decides. */
export interface FilterQuery {
  status_id?: string;
  assignee_id?: string;
  label_id?: string;
  priority?: IssuePriority;
  q?: string;
  sort: IssueSort;
}

/**
 * Turns the filter values into the query the list route reads, dropping the
 * blanks so an unset filter is absent rather than sent empty.
 */
export const filterQuery = (filters: FilterState): FilterQuery => ({
  ...(filters.statusId === '' ? {} : { status_id: filters.statusId }),
  ...(filters.assigneeId === '' ? {} : { assignee_id: filters.assigneeId }),
  ...(filters.labelId === '' ? {} : { label_id: filters.labelId }),
  ...(filters.priority === ''
    ? {}
    : { priority: filters.priority as IssuePriority }),
  ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
  sort: filters.sort,
});
