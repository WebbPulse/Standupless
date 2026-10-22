/**
 * Undo from a list: a property change or an archive made through the issue
 * collection is recorded, and undoing it writes the old values back through
 * the same routes.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IssueBulkRead,
  IssueBulkUpdate,
  IssueDeltaRead,
  IssueListFilters,
  OrderedIssueRead,
} from '../api/issues';
import { clearToasts } from '../lib/toast';
import { canUndo, clearUndo, undoLast } from '../lib/undo';
import type { IssueListRead, IssueUpdate } from '../types/Api';
import { useIssueCollection } from './useIssueCollection';

const listIssues =
  vi.fn<
    (workspaceId: string, query: IssueListFilters) => Promise<IssueListRead>
  >();
const updateIssue =
  vi.fn<
    (
      workspaceId: string,
      issueId: string,
      body: IssueUpdate
    ) => Promise<OrderedIssueRead>
  >();
const bulkUpdateIssues =
  vi.fn<
    (workspaceId: string, body: IssueBulkUpdate) => Promise<IssueBulkRead>
  >();

vi.mock('../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../api/issues')>('../api/issues');
  return {
    ...actual,
    listIssues: (workspaceId: string, query: IssueListFilters) =>
      listIssues(workspaceId, query),
    listIssueDelta: async (
      workspaceId: string,
      query: IssueListFilters
    ): Promise<IssueDeltaRead> => ({
      page: await listIssues(workspaceId, query),
      etag: undefined,
    }),
    updateIssue: (workspaceId: string, issueId: string, body: IssueUpdate) =>
      updateIssue(workspaceId, issueId, body),
    bulkUpdateIssues: (workspaceId: string, body: IssueBulkUpdate) =>
      bulkUpdateIssues(workspaceId, body),
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

/** An issue with the given id over a plain default. */
const issue = (
  id: string,
  fields: Partial<OrderedIssueRead> = {}
): OrderedIssueRead => ({
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
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...fields,
});

const query: IssueListFilters = { team_id: 'team-1', sort: 'updated_desc' };

/** Renders the hook over the given rows and waits for its first read. */
const mount = async (rows: OrderedIssueRead[]) => {
  listIssues.mockResolvedValue({
    issues: rows,
    next_cursor: null,
    synced_at: null,
    removed_ids: [],
    resync_required: false,
  });
  const hook = renderHook(() => useIssueCollection('ws-1', 'team-1', query));
  await waitFor(() => {
    expect(hook.result.current.isLoading).toBe(false);
  });
  return hook;
};

beforeEach(() => {
  listIssues.mockReset();
  updateIssue.mockReset();
  bulkUpdateIssues.mockReset();
  updateIssue.mockImplementation((_workspaceId, id, body) =>
    Promise.resolve(
      issue(id, {
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        updated_at: '2026-10-02T00:00:00Z',
      })
    )
  );
  bulkUpdateIssues.mockImplementation((_workspaceId, body) =>
    Promise.resolve({
      issues: body.issue_ids.map((id) =>
        issue(id, {
          ...(body.patch.status_id === undefined
            ? {}
            : { status_id: body.patch.status_id }),
          updated_at: '2026-10-02T00:00:00Z',
        })
      ),
      skipped: [],
    })
  );
});

afterEach(() => {
  clearUndo();
  clearToasts();
});

describe('useIssueCollection undo', () => {
  it('puts back the old priority of one issue', async () => {
    const hook = await mount([issue('a')]);

    act(() => {
      hook.result.current.update(['a'], { priority: 'high' });
    });
    await waitFor(() => {
      expect(canUndo('ws-1')).toBe(true);
    });

    await act(async () => {
      await undoLast('ws-1');
    });
    expect(updateIssue).toHaveBeenLastCalledWith('ws-1', 'a', {
      priority: 'medium',
    });
    expect(hook.result.current.issues[0]?.priority).toBe('medium');
  });

  it('puts back each old status of a bulk change in one write', async () => {
    const hook = await mount([issue('a'), issue('b')]);

    act(() => {
      hook.result.current.update(['a', 'b'], { status_id: 'st-done' });
    });
    await waitFor(() => {
      expect(canUndo('ws-1')).toBe(true);
    });

    await act(async () => {
      await undoLast('ws-1');
    });
    expect(bulkUpdateIssues).toHaveBeenLastCalledWith('ws-1', {
      issue_ids: ['a', 'b'],
      patch: { status_id: 'st-todo' },
    });
  });

  it('restores what an archive took away', async () => {
    const hook = await mount([issue('a')]);

    await act(async () => {
      await hook.result.current.archive?.(['a']);
    });
    expect(canUndo('ws-1')).toBe(true);

    await act(async () => {
      await undoLast('ws-1');
    });
    expect(bulkUpdateIssues).toHaveBeenLastCalledWith('ws-1', {
      issue_ids: ['a'],
      patch: { archived: false },
    });
  });
});
