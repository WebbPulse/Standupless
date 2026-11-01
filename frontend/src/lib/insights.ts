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
  InsightGroup,
  InsightMeasure,
  InsightTimeMeasure,
  InsightsRead,
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

/** Every measure in the order the picker offers them, with its name. */
export const INSIGHT_MEASURES: { value: InsightMeasure; label: string }[] = [
  { value: 'count', label: 'Issue count' },
  { value: 'points', label: 'Estimate points' },
  { value: 'cycle_time', label: 'Cycle time' },
  { value: 'lead_time', label: 'Lead time' },
  { value: 'triage_time', label: 'Triage time' },
  { value: 'issue_age', label: 'Issue age' },
];

const TIME_MEASURES: ReadonlySet<InsightMeasure> = new Set<InsightMeasure>([
  'cycle_time',
  'lead_time',
  'triage_time',
  'issue_age',
]);

/** Whether a measure answers durations and points rather than bar sums. */
export const isTimeMeasure = (
  measure: InsightMeasure
): measure is InsightTimeMeasure => TIME_MEASURES.has(measure);

/** The percentile markers a time measure draws, in the order the strip lists them. */
export const PERCENTILES = ['p25', 'p50', 'p75', 'p95'] as const;

/** One percentile marker's name. */
export type Percentile = (typeof PERCENTILES)[number];

const trim = (value: number): string =>
  value >= 10 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);

/**
 * A duration in hours printed in whichever unit reads better: hours under
 * two days, and days from there.
 */
export const formatHours = (hours: number): string => {
  if (hours < 48) return `${trim(hours)}h`;
  return `${trim(hours / 24)}d`;
};

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
 * closed issues and hidden sub-issues are left out of the bars as well. A
 * completed window of a past week or month keeps closed issues in, since the
 * list route has no filter that keeps open issues and recent closed ones together.
 */
export const insightsFilters = (
  state: ViewState,
  scope: IssueListFilters = {}
): Omit<IssueListFilters, 'sort'> => {
  const { sort: _sort, ...query } = viewStateQuery(state, scope);
  const closed: Pick<IssueListFilters, 'status_category_not'> =
    state.completed !== 'none'
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

/** The keys that open and close the panel on an issue list, Linear's own. */
export const INSIGHTS_PANEL_KEYS = 'mod+shift+i';

/** What the panel draws: both, the chart alone or the table alone. */
export type InsightsLayout = 'both' | 'chart' | 'table';

/** The panel's choices, which a viewer gets back when they reopen it. */
export interface InsightsPrefs {
  measure: InsightMeasure;
  groupBy: InsightDimension;
  segmentBy: InsightDimension | '';
  layout: InsightsLayout;
}

/** What a panel shows before anyone picks anything. */
export const DEFAULT_INSIGHTS_PREFS: InsightsPrefs = {
  measure: 'count',
  groupBy: 'status',
  segmentBy: '',
  layout: 'both',
};

const INSIGHTS_LAYOUTS: readonly InsightsLayout[] = ['both', 'chart', 'table'];

const insightsPrefsKey = (workspaceId: string, scopeKey: string): string =>
  `standupless.insights.${workspaceId}.${scopeKey}`;

const isDimension = (value: unknown): value is InsightDimension =>
  INSIGHT_DIMENSIONS.some((option) => option.value === value);

/**
 * The viewer's choices for one list, field by field, so a stale or hand edited
 * entry falls back to the default rather than asking the server for nonsense.
 */
export const readInsightsPrefs = (
  workspaceId: string,
  scopeKey: string
): InsightsPrefs => {
  try {
    const raw = globalThis.localStorage.getItem(
      insightsPrefsKey(workspaceId, scopeKey)
    );
    if (raw === null) return DEFAULT_INSIGHTS_PREFS;
    const stored = JSON.parse(raw) as Partial<
      Record<keyof InsightsPrefs, unknown>
    >;
    const measure = INSIGHT_MEASURES.find(
      (option) => option.value === stored.measure
    )?.value;
    const layout = INSIGHTS_LAYOUTS.find((option) => option === stored.layout);
    return {
      measure: measure ?? DEFAULT_INSIGHTS_PREFS.measure,
      groupBy: isDimension(stored.groupBy)
        ? stored.groupBy
        : DEFAULT_INSIGHTS_PREFS.groupBy,
      segmentBy: isDimension(stored.segmentBy) ? stored.segmentBy : '',
      layout: layout ?? DEFAULT_INSIGHTS_PREFS.layout,
    };
  } catch {
    return DEFAULT_INSIGHTS_PREFS;
  }
};

/** Keeps the viewer's choices for one list; a refused write only costs the memory of them. */
export const writeInsightsPrefs = (
  workspaceId: string,
  scopeKey: string,
  prefs: InsightsPrefs
): void => {
  try {
    globalThis.localStorage.setItem(
      insightsPrefsKey(workspaceId, scopeKey),
      JSON.stringify(prefs)
    );
  } catch {
    return;
  }
};

/**
 * The gridline values for a chart whose tallest bar is `max`: whole steps of
 * 1, 2 or 5 times a power of ten, rising to the first line at or above it.
 */
export const chartTicks = (max: number): number[] => {
  if (max <= 0) return [0, 1];
  const rough = max / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const nice =
    [1, 2, 5, 10]
      .map((factor) => factor * power)
      .find((step) => step >= rough) ?? 10 * power;
  const step = Math.max(1, nice);
  const lines = Math.ceil(max / step);
  return Array.from({ length: lines + 1 }, (_, line) => line * step);
};

/** One segment column: its bucket and the fill it draws in everywhere. */
export interface SegmentColumn {
  bucket: InsightBucket;
  key: string;
  color: string;
}

/**
 * The columns a segmented breakdown draws, from the server's totals, or from
 * the groups' own segments when an older server sends no totals.
 */
export const segmentColumns = (data: InsightsRead): SegmentColumn[] => {
  const seen = new Map<string, InsightBucket>();
  if ((data.segment_totals ?? []).length > 0) {
    for (const bucket of data.segment_totals ?? []) {
      seen.set(bucket.key ?? '', bucket);
    }
  } else {
    for (const group of data.groups) {
      for (const segment of group.segments) {
        if (!seen.has(segment.key ?? '')) {
          seen.set(segment.key ?? '', segment);
        }
      }
    }
  }
  return [...seen.entries()].map(([key, bucket], index) => ({
    key,
    bucket,
    color: bucketColor(bucket, index),
  }));
};

const ACROSS_ALL_NAMES: Record<InsightDimension, string> = {
  status: 'statuses',
  status_category: 'status types',
  assignee: 'assignees',
  creator: 'creators',
  priority: 'priorities',
  label: 'labels',
  project: 'projects',
  cycle: 'cycles',
  estimate: 'estimates',
  team: 'teams',
};

/** The name of the row that measures every issue once, whatever it is sliced by. */
export const acrossAllLabel = (dimension: InsightDimension): string =>
  `Across all ${ACROSS_ALL_NAMES[dimension]}`;

/** What the table's measure column is sorted by, null for the server's own order. */
export type InsightsSort = 'desc' | 'asc' | null;

/** The next sort a click on the measure column asks for. */
export const nextInsightsSort = (sort: InsightsSort): InsightsSort =>
  sort === null ? 'desc' : sort === 'desc' ? 'asc' : null;

const sortFigure = (bucket: InsightBucket, measure: InsightMeasure): number =>
  isTimeMeasure(measure) ? (bucket.durations?.average ?? -1) : bucket.value;

/** The groups in the chosen order, ties keeping the server's order. */
export const sortGroups = (
  groups: InsightGroup[],
  measure: InsightMeasure,
  sort: InsightsSort
): InsightGroup[] => {
  if (sort === null) return groups;
  const sign = sort === 'desc' ? -1 : 1;
  return [...groups].sort(
    (left, right) =>
      sign * (sortFigure(left, measure) - sortFigure(right, measure))
  );
};

/** One table cell: a bucket's figure, the average under a time measure. */
export const bucketFigure = (
  bucket: InsightBucket | undefined,
  measure: InsightMeasure
): string => {
  if (!isTimeMeasure(measure)) return String(bucket?.value ?? 0);
  const average = bucket?.durations?.average;
  return average === null || average === undefined ? '–' : formatHours(average);
};

/** A bar's figure in words: points also name the issues they sum over. */
export const barDetail = (
  bucket: InsightBucket,
  measure: InsightMeasure
): string => {
  const figure = formatMeasure(bucket.value, measure);
  return measure === 'points'
    ? `${figure} over ${formatMeasure(bucket.issue_count, 'count')}`
    : figure;
};

/** The panel's headline: the big figure and the words after it. */
export const insightsHeadline = (
  data: InsightsRead
): { figure: string; unit: string } => {
  const issues = data.issue_count === 1 ? 'issue' : 'issues';
  if (data.measure === 'points') {
    return {
      figure: String(data.total),
      unit: `${data.total === 1 ? 'point' : 'points'} over ${formatMeasure(data.issue_count, 'count')}`,
    };
  }
  if (isTimeMeasure(data.measure)) {
    const average = data.durations?.average;
    return {
      figure: String(data.issue_count),
      unit:
        average === null || average === undefined
          ? issues
          : `${issues}, average ${formatHours(average)}`,
    };
  }
  return { figure: String(data.total), unit: issues };
};
