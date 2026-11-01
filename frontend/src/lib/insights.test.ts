/**
 * What the insights panel sends and draws: that it sends the list's own query
 * with the client side display options made explicit, that a bar click
 * narrows one field to one value, and that bucket colors follow the palette.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INSIGHTS_PREFS,
  FILTER_FOR,
  INSIGHT_DIMENSIONS,
  UNSET_COLOR,
  INSIGHT_MEASURES,
  acrossAllLabel,
  bucketColor,
  bucketFigure,
  chartTicks,
  formatHours,
  formatMeasure,
  insightsFilters,
  insightsHeadline,
  isTimeMeasure,
  narrowTo,
  nextInsightsSort,
  readInsightsPrefs,
  segmentColumns,
  sortGroups,
  writeInsightsPrefs,
} from './insights';
import { defaultViewState, type ViewState } from './issueView';
import { STATUS_COLOR_VALUES } from './statusAppearance';
import type { InsightsRead } from '../types/Api';

const base = defaultViewState();

describe('insightsFilters', () => {
  it('sends the list query without its sort', () => {
    const state: ViewState = {
      ...base,
      filters: [{ field: 'priority', op: 'is', values: ['high'] }],
    };

    expect(insightsFilters(state, { team_id: 'team-1' })).toEqual({
      team_id: 'team-1',
      priority: ['high'],
    });
  });

  it('leaves out what the display options hide', () => {
    const state: ViewState = {
      ...base,
      completed: 'none',
      showSubIssues: false,
    };

    expect(insightsFilters(state, { status_category_not: 'backlog' })).toEqual({
      status_category_not: ['backlog', 'completed', 'cancelled'],
      parent_id: 'none',
    });
  });
});

describe('narrowTo', () => {
  it('replaces the field clause with exactly the picked value', () => {
    const filters = narrowTo(
      [
        { field: 'assignee', op: 'is_not', values: ['user-1'] },
        { field: 'label', op: 'is', values: ['lb-1'] },
      ],
      'assignee',
      'none'
    );

    expect(filters).toEqual([
      { field: 'label', op: 'is', values: ['lb-1'] },
      { field: 'assignee', op: 'is', values: ['none'] },
    ]);
  });
});

describe('bucketColor', () => {
  const bucket = { label: 'x', value: 1, issue_count: 1 };

  it('reads palette names, hex values and the unset bucket', () => {
    expect(bucketColor({ ...bucket, key: 's', color: 'green' }, 0)).toBe(
      STATUS_COLOR_VALUES.green
    );
    expect(bucketColor({ ...bucket, key: 'l', color: '#ff0000' }, 0)).toBe(
      '#ff0000'
    );
    expect(bucketColor({ ...bucket, key: null, color: null }, 0)).toBe(
      UNSET_COLOR
    );
  });

  it('gives uncolored neighbours different tones', () => {
    const first = bucketColor({ ...bucket, key: 'a', color: null }, 0);
    const second = bucketColor({ ...bucket, key: 'b', color: null }, 1);
    expect(first).not.toBe(second);
  });
});

describe('formatMeasure', () => {
  it('names the unit and its plural', () => {
    expect(formatMeasure(1, 'count')).toBe('1 issue');
    expect(formatMeasure(3, 'points')).toBe('3 points');
  });
});

describe('INSIGHT_DIMENSIONS', () => {
  it('offers team as a dimension, drawn as plain rows', () => {
    expect(INSIGHT_DIMENSIONS).toContainEqual({ value: 'team', label: 'Team' });
    expect(FILTER_FOR.team).toBeUndefined();
  });
});

describe('a bounded completed window', () => {
  it('keeps closed issues in the panel, as the list route cannot split them', () => {
    const state: ViewState = { ...base, completed: 'past_week' };

    expect(insightsFilters(state, {}).status_category_not).toBeUndefined();
  });
});

describe('time measures', () => {
  it('lists every measure and tells the timed ones apart', () => {
    expect(INSIGHT_MEASURES.map((option) => option.value)).toEqual([
      'count',
      'points',
      'cycle_time',
      'lead_time',
      'triage_time',
      'issue_age',
    ]);
    expect(isTimeMeasure('cycle_time')).toBe(true);
    expect(isTimeMeasure('issue_age')).toBe(true);
    expect(isTimeMeasure('points')).toBe(false);
  });

  it('prints durations in hours under two days and in days from there', () => {
    expect(formatHours(0.25)).toBe('0.3h');
    expect(formatHours(5.25)).toBe('5.3h');
    expect(formatHours(30)).toBe('30h');
    expect(formatHours(72)).toBe('3d');
    expect(formatHours(36 * 24)).toBe('36d');
  });
});

const bucket = (key: string | null, value: number) => ({
  key,
  label: key ?? 'None',
  color: null,
  value,
  issue_count: value,
});

const breakdown = (overrides: Partial<InsightsRead> = {}): InsightsRead => ({
  team_ids: [],
  view_id: null,
  group_by: 'status',
  segment_by: null,
  measure: 'count',
  total: 0,
  issue_count: 0,
  groups: [],
  truncated: false,
  row_cap: 2000,
  ...overrides,
});

describe('chartTicks', () => {
  it('rises in whole round steps to the first line at or above the top', () => {
    expect(chartTicks(44)).toEqual([0, 10, 20, 30, 40, 50]);
    expect(chartTicks(3)).toEqual([0, 1, 2, 3]);
    expect(chartTicks(1)).toEqual([0, 1]);
    expect(chartTicks(120)).toEqual([0, 50, 100, 150]);
  });

  it('still draws a scale over nothing', () => {
    expect(chartTicks(0)).toEqual([0, 1]);
  });
});

describe('segmentColumns', () => {
  it('prefers the totals and falls back to the groups segments', () => {
    const groups = [{ ...bucket('a', 1), segments: [bucket('x', 1)] }];
    expect(
      segmentColumns(
        breakdown({ groups, segment_totals: [bucket('y', 2), bucket('x', 1)] })
      ).map((column) => column.key)
    ).toEqual(['y', 'x']);
    expect(
      segmentColumns(breakdown({ groups })).map((column) => column.key)
    ).toEqual(['x']);
  });
});

describe('sortGroups', () => {
  const groups = [
    { ...bucket('a', 1), segments: [] },
    { ...bucket('b', 3), segments: [] },
    { ...bucket('c', 2), segments: [] },
  ];

  it('orders by the figure, or keeps the server order with no sort', () => {
    const keys = (sort: 'asc' | 'desc' | null) =>
      sortGroups(groups, 'count', sort).map((group) => group.key);
    expect(keys('desc')).toEqual(['b', 'c', 'a']);
    expect(keys('asc')).toEqual(['a', 'c', 'b']);
    expect(keys(null)).toEqual(['a', 'b', 'c']);
  });

  it('cycles from descending to ascending to none', () => {
    expect(nextInsightsSort(null)).toBe('desc');
    expect(nextInsightsSort('desc')).toBe('asc');
    expect(nextInsightsSort('asc')).toBeNull();
  });
});

describe('bucketFigure', () => {
  it('prints the value, zero for a missing bucket, the average for time', () => {
    expect(bucketFigure(bucket('a', 4), 'count')).toBe('4');
    expect(bucketFigure(undefined, 'points')).toBe('0');
    expect(
      bucketFigure(
        {
          ...bucket('a', 1),
          durations: {
            count: 1,
            average: 30,
            p25: 30,
            p50: 30,
            p75: 30,
            p95: 30,
            minimum: 30,
            maximum: 30,
          },
        },
        'cycle_time'
      )
    ).toBe('30h');
    expect(bucketFigure(undefined, 'cycle_time')).toBe('–');
  });
});

describe('insightsHeadline', () => {
  it('names the figure in each measure', () => {
    expect(insightsHeadline(breakdown({ total: 44, issue_count: 44 }))).toEqual(
      { figure: '44', unit: 'issues' }
    );
    expect(
      insightsHeadline(
        breakdown({ measure: 'points', total: 8, issue_count: 1 })
      )
    ).toEqual({ figure: '8', unit: 'points over 1 issue' });
  });
});

describe('acrossAllLabel', () => {
  it('names the row in the plural of the slice', () => {
    expect(acrossAllLabel('priority')).toBe('Across all priorities');
    expect(acrossAllLabel('status_category')).toBe('Across all status types');
  });
});

describe('insights prefs', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('round trips per list and starts from the defaults', () => {
    expect(readInsightsPrefs('ws', 'team')).toEqual(DEFAULT_INSIGHTS_PREFS);
    const picked = {
      measure: 'points',
      groupBy: 'label',
      segmentBy: 'priority',
      layout: 'table',
    } as const;
    writeInsightsPrefs('ws', 'team', picked);
    expect(readInsightsPrefs('ws', 'team')).toEqual(picked);
    expect(readInsightsPrefs('ws', 'other')).toEqual(DEFAULT_INSIGHTS_PREFS);
  });

  it('falls back field by field on a stale or broken entry', () => {
    globalThis.localStorage.setItem(
      'standupless.insights.ws.team',
      JSON.stringify({ measure: 'gone', groupBy: 'label', layout: 'odd' })
    );
    expect(readInsightsPrefs('ws', 'team')).toEqual({
      ...DEFAULT_INSIGHTS_PREFS,
      groupBy: 'label',
    });
    globalThis.localStorage.setItem('standupless.insights.ws.team', '{');
    expect(readInsightsPrefs('ws', 'team')).toEqual(DEFAULT_INSIGHTS_PREFS);
  });
});
