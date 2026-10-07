/**
 * What the insights panel sends and draws: that it sends the list's own query
 * with the client side display options made explicit, that a bar click
 * narrows one field to one value, and that bucket colors follow the palette.
 */

import { describe, expect, it } from 'vitest';
import {
  UNSET_COLOR,
  bucketColor,
  formatMeasure,
  insightsFilters,
  narrowTo,
} from './insights';
import { defaultViewState, type ViewState } from './issueView';
import { STATUS_COLOR_VALUES } from './statusAppearance';

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
      showCompleted: false,
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
