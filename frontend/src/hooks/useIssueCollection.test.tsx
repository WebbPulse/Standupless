/**
 * Delta polling in the issue collection: one full read, then polls that send
 * the cursor back and fold the answer in, and a full read again when the
 * server asks for one.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueListFilters, OrderedIssueRead } from '../api/issues';
import type { IssueListRead } from '../types/Api';
import { useIssueCollection } from './useIssueCollection';

const listIssues =
  vi.fn<
    (workspaceId: string, query: IssueListFilters) => Promise<IssueListRead>
  >();

vi.mock('../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../api/issues')>('../api/issues');
  return {
    ...actual,
    listIssues: (workspaceId: string, query: IssueListFilters) =>
      listIssues(workspaceId, query),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** An issue with the given id and update time over a plain default. */
const issue = (id: string, updatedAt: string): OrderedIssueRead => ({
  id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: `ENG-${id}`,
  number: 1,
  title: id,
  body: null,
  status_id: 'st-todo',
  priority: 'medium',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: updatedAt,
});

/** A list body with the delta fields filled. */
const page = (fields: Partial<IssueListRead>): IssueListRead => ({
  issues: [],
  next_cursor: null,
  synced_at: null,
  removed_ids: [],
  resync_required: false,
  ...fields,
});

const query: IssueListFilters = { team_id: 'team-1', sort: 'updated_desc' };

/** Renders the hook and waits for its first full read. */
const mount = async () => {
  const hook = renderHook(() => useIssueCollection('ws-1', 'team-1', query));
  await waitFor(() => {
    expect(hook.result.current.isLoading).toBe(false);
  });
  return hook;
};

/** Forces one poll and waits for the given number of reads in total. */
const poll = async (hook: Awaited<ReturnType<typeof mount>>, calls: number) => {
  act(() => {
    invalidateQueries(hook.result.current.queryKey);
  });
  await waitFor(() => {
    expect(listIssues).toHaveBeenCalledTimes(calls);
  });
};

describe('useIssueCollection delta polling', () => {
  beforeEach(() => {
    listIssues.mockReset();
  });

  it('polls with the cursor and folds the delta into the rows', async () => {
    listIssues.mockResolvedValueOnce(
      page({
        issues: [
          issue('a', '2026-09-17T02:00:00Z'),
          issue('b', '2026-09-17T01:00:00Z'),
        ],
        synced_at: '2026-09-17T02:00:00Z',
      })
    );
    const hook = await mount();
    expect(hook.result.current.issues.map((row) => row.id)).toEqual(['a', 'b']);

    listIssues.mockResolvedValueOnce(
      page({
        issues: [issue('c', '2026-09-17T03:00:00Z')],
        removed_ids: ['a'],
        synced_at: '2026-09-17T02:30:00Z',
      })
    );
    await poll(hook, 2);

    expect(listIssues.mock.calls[1]?.[1]).toMatchObject({
      team_id: 'team-1',
      updated_since: '2026-09-17T02:00:00Z',
    });
    await waitFor(() => {
      expect(hook.result.current.issues.map((row) => row.id)).toEqual([
        'c',
        'b',
      ]);
    });

    listIssues.mockResolvedValueOnce(
      page({ synced_at: '2026-09-17T02:30:00Z' })
    );
    await poll(hook, 3);
    expect(listIssues.mock.calls[2]?.[1]).toMatchObject({
      updated_since: '2026-09-17T02:30:00Z',
    });
  });

  it('reads every page again when the server asks for a resync', async () => {
    listIssues.mockResolvedValueOnce(
      page({
        issues: [issue('a', '2026-09-17T02:00:00Z')],
        synced_at: '2026-09-17T02:00:00Z',
      })
    );
    const hook = await mount();

    listIssues.mockResolvedValueOnce(
      page({ resync_required: true, synced_at: '2026-09-17T02:00:00Z' })
    );
    listIssues.mockResolvedValueOnce(
      page({
        issues: [issue('z', '2026-09-17T09:00:00Z')],
        synced_at: '2026-09-17T09:00:00Z',
      })
    );
    await poll(hook, 3);

    expect(listIssues.mock.calls[2]?.[1]).not.toHaveProperty('updated_since');
    await waitFor(() => {
      expect(hook.result.current.issues.map((row) => row.id)).toEqual(['z']);
    });
  });

  it('keeps reading in full when the server hands out no cursor', async () => {
    listIssues.mockResolvedValue(
      page({ issues: [issue('a', '2026-09-17T02:00:00Z')] })
    );
    const hook = await mount();

    await poll(hook, 2);

    expect(listIssues.mock.calls[1]?.[1]).not.toHaveProperty('updated_since');
  });
});
