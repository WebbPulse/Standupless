/**
 * The insights panel: that it asks for the breakdown the pickers name over
 * the list's filters, draws one bar per group with the unit and the truncated
 * note, and narrows the list when a filterable bar is clicked.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsightsQuery } from '../../../api/insights';
import type { InsightsRead } from '../../../types/Api';
import { InsightsChart, InsightsPanel } from './InsightsPanel';

const getInsights =
  vi.fn<(workspaceId: string, query: InsightsQuery) => Promise<InsightsRead>>();

vi.mock('../../../api/insights', () => ({
  getInsights: (workspaceId: string, query: InsightsQuery) =>
    getInsights(workspaceId, query),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const read = (overrides: Partial<InsightsRead> = {}): InsightsRead => ({
  team_ids: ['team-1'],
  view_id: null,
  group_by: 'assignee',
  segment_by: null,
  measure: 'count',
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
    },
    {
      key: null,
      label: 'No assignee',
      color: null,
      value: 1,
      issue_count: 1,
      segments: [],
    },
  ],
  truncated: false,
  row_cap: 2000,
  ...overrides,
});

beforeEach(() => {
  getInsights.mockReset();
});

describe('InsightsPanel', () => {
  it('reads the picked breakdown over the list filters', async () => {
    getInsights.mockResolvedValue(
      read({ group_by: 'status', truncated: true })
    );

    render(
      <InsightsPanel
        workspaceId="ws-1"
        scopeKey="team-1"
        filters={{ team_id: 'team-1', priority: ['high'] }}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('3 issues')).toBeTruthy();
    });
    expect(getInsights).toHaveBeenCalledWith('ws-1', {
      team_id: 'team-1',
      priority: ['high'],
      group_by: 'status',
      measure: 'count',
    });
    expect(screen.getByText(/Counted the first 2000 issues/)).toBeTruthy();

    getInsights.mockResolvedValue(read({ measure: 'points' }));
    fireEvent.change(screen.getByLabelText('Measure'), {
      target: { value: 'points' },
    });
    fireEvent.change(screen.getByLabelText('Segment by'), {
      target: { value: 'priority' },
    });

    await waitFor(() => {
      expect(getInsights).toHaveBeenLastCalledWith('ws-1', {
        team_id: 'team-1',
        priority: ['high'],
        group_by: 'status',
        measure: 'points',
        segment_by: 'priority',
      });
    });
  });
});

describe('InsightsChart', () => {
  it('narrows the list to a bar, the unset bucket as none', () => {
    const onPick = vi.fn();
    render(<InsightsChart data={read()} onPick={onPick} />);

    fireEvent.click(screen.getByRole('button', { name: /^No assignee/ }));
    expect(onPick).toHaveBeenCalledWith('assignee', 'none');

    fireEvent.click(screen.getByRole('button', { name: /^Mo Member/ }));
    expect(onPick).toHaveBeenLastCalledWith('assignee', 'user-1');
  });

  it('draws bars on a dimension without a list filter as plain rows', () => {
    render(
      <InsightsChart data={read({ group_by: 'creator' })} onPick={vi.fn()} />
    );

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('Mo Member')).toBeTruthy();
  });

  it('shows a legend for segments and an empty state', () => {
    const segmented = read({
      segment_by: 'priority',
      groups: [
        {
          key: 'user-1',
          label: 'Mo Member',
          color: null,
          value: 2,
          issue_count: 2,
          segments: [
            {
              key: 'high',
              label: 'High',
              color: null,
              value: 1,
              issue_count: 1,
            },
            { key: 'low', label: 'Low', color: null, value: 1, issue_count: 1 },
          ],
        },
      ],
    });
    const { rerender } = render(<InsightsChart data={segmented} />);

    expect(screen.getByRole('list', { name: 'Segments' }).textContent).toBe(
      'HighLow'
    );

    rerender(<InsightsChart data={read({ groups: [] })} />);
    expect(screen.getByText('No issues match this filter.')).toBeTruthy();
  });
});
