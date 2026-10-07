/**
 * The insights contract the panel depends on: the path under the views
 * prefix, list filters passed through as query keys, and a body whose missing
 * fields fall back rather than break the chart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getInsights, insightsPath } from './insights';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
  },
}));

beforeEach(() => {
  get.mockReset();
});

describe('getInsights', () => {
  it('reads the views insights route with the filters as query keys', async () => {
    get.mockResolvedValue({
      data: {
        team_ids: ['team-1'],
        view_id: null,
        group_by: 'assignee',
        segment_by: null,
        measure: 'count',
        total: 2,
        issue_count: 2,
        groups: [
          {
            key: null,
            label: 'No assignee',
            color: null,
            value: 2,
            issue_count: 2,
            segments: [],
          },
        ],
        truncated: false,
        row_cap: 2000,
      },
    });

    const read = await getInsights('ws-1', {
      team_id: 'team-1',
      group_by: 'assignee',
      priority: ['high', 'urgent'],
    });

    expect(insightsPath('ws-1')).toBe('/api/workspaces/ws-1/views/insights');
    expect(get).toHaveBeenCalledWith('/api/workspaces/ws-1/views/insights', {
      query: {
        team_id: 'team-1',
        group_by: 'assignee',
        priority: ['high', 'urgent'],
      },
    });
    expect(read.total).toBe(2);
    expect(read.groups[0]?.label).toBe('No assignee');
  });

  it('fills a sparse body', async () => {
    get.mockResolvedValue({ data: {} });

    const read = await getInsights('ws-1', { group_by: 'status' });

    expect(read).toMatchObject({
      group_by: 'status',
      measure: 'count',
      groups: [],
      truncated: false,
    });
  });
});
