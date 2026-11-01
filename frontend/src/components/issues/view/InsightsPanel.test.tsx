/**
 * The view insights panel: that it asks for the breakdown the pickers name over
 * the list's filters, keeps those picks for the next time it opens, draws the
 * chart and the table with the headline and the truncated note, closes on its
 * keys from inside a picker, and narrows the list when a filterable bar is
 * clicked.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsightsQuery } from '../../../api/insights';
import type { InsightsRead } from '../../../types/Api';
import { InsightsChart, InsightsPanel } from './InsightsPanel';
import InsightsBars from './InsightsBars';
import InsightsTable from './InsightsTable';

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

const segmented = (): InsightsRead =>
  read({
    segment_by: 'priority',
    total: 3,
    segment_totals: [
      { key: 'high', label: 'High', color: null, value: 2, issue_count: 2 },
      { key: 'low', label: 'Low', color: null, value: 1, issue_count: 1 },
    ],
    groups: [
      {
        key: 'user-1',
        label: 'Mo Member',
        color: null,
        value: 2,
        issue_count: 2,
        segments: [
          { key: 'high', label: 'High', color: null, value: 2, issue_count: 2 },
        ],
      },
      {
        key: null,
        label: 'No assignee',
        color: null,
        value: 1,
        issue_count: 1,
        segments: [
          { key: 'high', label: 'High', color: null, value: 0, issue_count: 0 },
          { key: 'low', label: 'Low', color: null, value: 1, issue_count: 1 },
        ],
      },
    ],
  });

beforeEach(() => {
  getInsights.mockReset();
  globalThis.localStorage.clear();
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
      expect(screen.getByText('issues')).toBeTruthy();
    });
    expect(screen.getByText('issues').previousElementSibling?.textContent).toBe(
      '3'
    );
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
    fireEvent.change(screen.getByLabelText('Segment'), {
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

  it('keeps the picks for the next time the panel opens', async () => {
    getInsights.mockResolvedValue(read());
    const panel = (
      <InsightsPanel
        workspaceId="ws-1"
        scopeKey="team-1"
        filters={{ team_id: 'team-1' }}
        onClose={vi.fn()}
      />
    );

    const { unmount } = render(panel);
    fireEvent.change(screen.getByLabelText('Slice'), {
      target: { value: 'assignee' },
    });
    await waitFor(() => {
      expect(getInsights).toHaveBeenLastCalledWith(
        'ws-1',
        expect.objectContaining({ group_by: 'assignee' })
      );
    });
    unmount();

    render(panel);
    expect((screen.getByLabelText('Slice') as HTMLSelectElement).value).toBe(
      'assignee'
    );
  });

  it('closes on its keys while a picker holds focus', () => {
    getInsights.mockResolvedValue(read());
    const onClose = vi.fn();
    render(
      <InsightsPanel
        workspaceId="ws-1"
        scopeKey="team-1"
        filters={{ team_id: 'team-1' }}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(screen.getByLabelText('Measure'), {
      key: 'I',
      code: 'KeyI',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers expanding only when the page can grow it', async () => {
    getInsights.mockResolvedValue(read());
    const onToggleExpanded = vi.fn();
    render(
      <InsightsPanel
        workspaceId="ws-1"
        scopeKey="team-1"
        filters={{ team_id: 'team-1' }}
        onToggleExpanded={onToggleExpanded}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand insights' }));
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.getByText('Across all statuses')).toBeTruthy();
    });
  });
});

describe('InsightsBars', () => {
  it('narrows the list to a column, the unset bucket as none', () => {
    const onPick = vi.fn();
    render(<InsightsBars data={read()} onPick={onPick} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'No assignee, 1 issue. Filter the list to it',
      })
    );
    expect(onPick).toHaveBeenCalledWith('assignee', 'none');
  });

  it('draws columns on a dimension without a list filter as images', () => {
    render(
      <InsightsBars data={read({ group_by: 'creator' })} onPick={vi.fn()} />
    );

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(
      screen.getByRole('img', { name: 'Mo Member, 2 issues' })
    ).toBeTruthy();
  });

  it('shows the legend and the names only when labelled', () => {
    const { rerender } = render(<InsightsBars data={segmented()} />);
    expect(screen.queryByRole('list', { name: 'Segments' })).toBeNull();

    rerender(<InsightsBars data={segmented()} labelled />);
    expect(screen.getByRole('list', { name: 'Segments' }).textContent).toBe(
      'HighLow'
    );
  });
});

describe('InsightsTable', () => {
  it('draws an across all row from the totals and a column per segment', () => {
    render(<InsightsTable data={segmented()} sort={null} onSort={vi.fn()} />);

    const rows = screen.getAllByRole('row');
    expect(
      [...(rows[0]?.querySelectorAll('th') ?? [])].map(
        (cell) => cell.textContent
      )
    ).toEqual(['Assignee', 'Issue count', 'High', 'Low']);
    expect(
      [...(rows[1]?.children ?? [])].map((cell) => cell.textContent)
    ).toEqual(['Across all assignees', '3', '2', '1']);
    expect(
      [...(rows[2]?.children ?? [])].map((cell) => cell.textContent)
    ).toEqual(['Mo Member', '2', '2', '0']);
  });

  it('narrows the list from a row and cycles the sort from the header', () => {
    const onPick = vi.fn();
    const onSort = vi.fn();
    render(
      <InsightsTable
        data={segmented()}
        sort="desc"
        onSort={onSort}
        onPick={onPick}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Filter the list to No assignee' })
    );
    expect(onPick).toHaveBeenCalledWith('assignee', 'none');

    fireEvent.click(screen.getByRole('button', { name: 'Issue count' }));
    expect(onSort).toHaveBeenCalledWith('asc');
    expect(
      screen
        .getByRole('columnheader', { name: 'Issue count' })
        .getAttribute('aria-sort')
    ).toBe('descending');
  });
});

describe('InsightsPanel time measures', () => {
  it('offers the time measures and draws a scatterplot for one', async () => {
    getInsights.mockResolvedValue(read());

    render(
      <InsightsPanel
        workspaceId="ws-1"
        scopeKey="team-1"
        filters={{ team_id: 'team-1' }}
        onClose={vi.fn()}
      />
    );

    const picker = screen.getByLabelText('Measure');
    expect(
      [...picker.querySelectorAll('option')].map((option) => option.textContent)
    ).toEqual([
      'Issue count',
      'Estimate points',
      'Cycle time',
      'Lead time',
      'Triage time',
      'Issue age',
    ]);

    getInsights.mockResolvedValue(
      read({
        measure: 'cycle_time',
        issue_count: 1,
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
        points: [
          {
            issue_id: 'i-1',
            key: 'ABC-1',
            title: 'Timed',
            group: 'user-1',
            segment: null,
            hours: 30,
          },
        ],
      })
    );
    fireEvent.change(picker, { target: { value: 'cycle_time' } });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'ABC-1 Timed, 30h' })
      ).toBeTruthy();
    });
    expect(getInsights).toHaveBeenLastCalledWith('ws-1', {
      team_id: 'team-1',
      group_by: 'status',
      measure: 'cycle_time',
    });
    expect(screen.getByText('issue, average 30h')).toBeTruthy();
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
