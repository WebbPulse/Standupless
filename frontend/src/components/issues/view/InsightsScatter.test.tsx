/**
 * The time measure scatterplot: one dot per issue that opens it, a percentile
 * strip that zooms the y-axis and hides the dots above, and an empty state.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InsightsRead } from '../../../types/Api';
import { InsightsScatter } from './InsightsScatter';

const durations = {
  count: 3,
  average: 34,
  p25: 6,
  p50: 10,
  p75: 29,
  p95: 44.2,
  minimum: 2,
  maximum: 48,
};

const read = (overrides: Partial<InsightsRead> = {}): InsightsRead => ({
  team_ids: ['team-1'],
  view_id: null,
  group_by: 'assignee',
  segment_by: null,
  measure: 'cycle_time',
  total: 3,
  issue_count: 3,
  groups: [
    {
      key: 'user-1',
      label: 'Mo Member',
      color: null,
      value: 2,
      issue_count: 2,
      segments: [],
      durations: { ...durations, count: 2, p50: 6 },
    },
    {
      key: null,
      label: 'No assignee',
      color: null,
      value: 1,
      issue_count: 1,
      segments: [],
      durations: { ...durations, count: 1, p50: 48 },
    },
  ],
  truncated: false,
  row_cap: 2000,
  durations,
  points: [
    {
      issue_id: 'i-1',
      key: 'ABC-1',
      title: 'Fast',
      group: 'user-1',
      segment: null,
      hours: 2,
    },
    {
      issue_id: 'i-2',
      key: 'ABC-2',
      title: 'Slow',
      group: 'user-1',
      segment: null,
      hours: 10,
    },
    {
      issue_id: 'i-3',
      key: 'ABC-3',
      title: 'Slowest',
      group: null,
      segment: null,
      hours: 48,
    },
  ],
  ...overrides,
});

describe('InsightsScatter', () => {
  it('draws a dot per issue that opens it', () => {
    const onOpenIssue = vi.fn();
    render(<InsightsScatter data={read()} onOpenIssue={onOpenIssue} />);

    fireEvent.click(screen.getByRole('button', { name: 'ABC-3 Slowest, 2d' }));
    expect(onOpenIssue).toHaveBeenCalledWith({ id: 'i-3', key: 'ABC-3' });

    fireEvent.keyDown(screen.getByRole('button', { name: 'ABC-1 Fast, 2h' }), {
      key: 'Enter',
    });
    expect(onOpenIssue).toHaveBeenLastCalledWith({ id: 'i-1', key: 'ABC-1' });
    expect(screen.getByRole('list', { name: 'Buckets' }).textContent).toBe(
      'Mo MemberNo assignee'
    );
  });

  it('zooms to a percentile and back', () => {
    render(<InsightsScatter data={read()} />);

    const median = screen.getByRole('button', { name: /^P50/ });
    expect(median.textContent).toContain('10h');
    fireEvent.click(median);

    expect(median.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /ABC-3/ })).toBeNull();
    expect(screen.getByText(/1 issue sits above this/)).toBeTruthy();

    fireEvent.click(median);
    expect(median.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: /ABC-3/ })).toBeTruthy();
  });

  it('shows an empty state without points', () => {
    render(
      <InsightsScatter
        data={read({ points: [], durations: null, groups: [] })}
      />
    );
    expect(screen.getByText('No issues match this measure.')).toBeTruthy();
  });
});
