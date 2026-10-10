/**
 * The vocabulary the insights panel draws with: the dimensions it offers, the
 * list filter each bar narrows to, the colors buckets fill in and how figures
 * print. Kept apart from the component so the component file stays refresh
 * safe.
 */

import type { IssueListFilters } from '../api/issues';
import {
  viewStateQuery,
  type FilterClause,
  type FilterField,
  type ViewState,
} from './issueView';
import {
  STATUS_COLORS,
  STATUS_COLOR_VALUES,
  isStatusColor,
} from './statusAppearance';
import type {
  InsightBucket,
  InsightDimension,
  InsightMeasure,
} from '../types/Api';

/** How often an open panel re-reads, matching the pace of the list beside it. */
export const INSIGHTS_POLL_MS = 60000;

/** Every dimension in the order the pickers offer them, with its name. */
export const INSIGHT_DIMENSIONS: { value: InsightDimension; label: string }[] =
  [
    { value: 'status', label: 'Status' },
    { value: 'status_category', label: 'Status type' },
    { value: 'assignee', label: 'Assignee' },
    { value: 'creator', label: 'Creator' },
    { value: 'priority', label: 'Priority' },
    { value: 'label', label: 'Label' },
    { value: 'project', label: 'Project' },
    { value: 'cycle', label: 'Cycle' },
    { value: 'estimate', label: 'Estimate' },
    { value: 'team', label: 'Team' },
  ];

/** The list filter a bar narrows to, for the dimensions the filter bar knows. */
export const FILTER_FOR: Partial<Record<InsightDimension, FilterField>> = {
  status: 'status',
  assignee: 'assignee',
  priority: 'priority',
  label: 'label',
  project: 'project',
  cycle: 'cycle',
};

/** The fill of an unset bucket, such as unassigned. */
export const UNSET_COLOR = STATUS_COLOR_VALUES.gray;

const CYCLE_COLORS = STATUS_COLORS.filter((color) => color !== 'gray').map(
  (color) => STATUS_COLOR_VALUES[color]
);

/**
 * The fill a bucket draws in: a status's palette tone, a label's or project's
 * own hex, gray for the unset bucket, and otherwise a palette tone picked by
 * position so neighbouring segments stay apart.
 */
export const bucketColor = (bucket: InsightBucket, index: number): string => {
  if (bucket.key === null) return UNSET_COLOR;
  const color = bucket.color;
  if (isStatusColor(color)) return STATUS_COLOR_VALUES[color];
  if (typeof color === 'string' && color.startsWith('#')) return color;
  return CYCLE_COLORS[index % CYCLE_COLORS.length] ?? UNSET_COLOR;
};

/** A figure with its unit, as the bar and the total print it. */
export const formatMeasure = (
  value: number,
  measure: InsightMeasure
): string =>
  measure === 'points'
    ? `${value} ${value === 1 ? 'point' : 'points'}`
    : `${value} ${value === 1 ? 'issue' : 'issues'}`;

const asList = <T extends string>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * The filters a panel sends for a list state: the list's own query without its
 * sort, plus the display options the list applies on the client, so hidden
 * closed issues and hidden sub-issues are left out of the bars as well.
 */
export const insightsFilters = (
  state: ViewState,
  scope: IssueListFilters = {}
): Omit<IssueListFilters, 'sort'> => {
  const { sort: _sort, ...query } = viewStateQuery(state, scope);
  const closed: Pick<IssueListFilters, 'status_category_not'> =
    state.showCompleted
      ? {}
      : {
          status_category_not: [
            ...new Set([
              ...asList(query.status_category_not),
              'completed' as const,
              'cancelled' as const,
            ]),
          ],
        };
  return {
    ...query,
    ...closed,
    ...(state.showSubIssues ? {} : { parent_id: 'none' }),
  };
};

/** The filters with one field narrowed to exactly one value, as a bar click asks. */
export const narrowTo = (
  filters: FilterClause[],
  field: FilterField,
  value: string
): FilterClause[] => [
  ...filters.filter((clause) => clause.field !== field),
  { field, op: 'is', values: [value] },
];
