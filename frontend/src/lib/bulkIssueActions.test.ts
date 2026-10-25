/**
 * The bulk actions with no bulk route: a move to another team runs the move
 * route once per issue, parents before their sub-issues, records one undo
 * and names the count, and a subscribe or unsubscribe covers every issue
 * with one notice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRead, IssueUpdate, SubscribersRead } from '../types/Api';
import {
  issueCount,
  moveIssues,
  moveOrder,
  setSubscriptions,
} from './bulkIssueActions';
import { clearToasts, currentToasts } from './toast';
import { canUndo, clearUndo, undoLast } from './undo';

const moveIssue =
  vi.fn<
    (workspaceId: string, issueId: string, teamId: string) => Promise<IssueRead>
  >();
const updateIssue =
  vi.fn<
    (
      workspaceId: string,
      issueId: string,
      body: IssueUpdate
    ) => Promise<IssueRead>
  >();
const subscribe =
  vi.fn<(workspaceId: string, issueId: string) => Promise<SubscribersRead>>();
const unsubscribe =
  vi.fn<(workspaceId: string, issueId: string) => Promise<SubscribersRead>>();

vi.mock('../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../api/issues')>('../api/issues');
  return {
    ...actual,
    moveIssue: (workspaceId: string, issueId: string, teamId: string) =>
      moveIssue(workspaceId, issueId, teamId),
    updateIssue: (workspaceId: string, issueId: string, body: IssueUpdate) =>
      updateIssue(workspaceId, issueId, body),
  };
});

vi.mock('../api/notifications', async () => {
  const actual = await vi.importActual<typeof import('../api/notifications')>(
    '../api/notifications'
  );
  return {
    ...actual,
    subscribe: (workspaceId: string, issueId: string) =>
      subscribe(workspaceId, issueId),
    unsubscribe: (workspaceId: string, issueId: string) =>
      unsubscribe(workspaceId, issueId),
  };
});

/** An issue with the given id over a plain default. */
const issue = (id: string, fields: Partial<IssueRead> = {}): IssueRead => ({
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

const OPS = { id: 'team-2', name: 'Ops' };

const messages = (): string[] => currentToasts().map((toast) => toast.message);

const NOBODY: SubscribersRead = { subscribers: [], subscribed: false };

beforeEach(() => {
  clearUndo();
  clearToasts();
  moveIssue.mockReset();
  updateIssue.mockReset();
  subscribe.mockReset();
  unsubscribe.mockReset();
  moveIssue.mockImplementation((_ws, id, teamId) =>
    Promise.resolve(issue(id, { team_id: teamId, key: `OPS-${id}` }))
  );
  updateIssue.mockImplementation((_ws, id) => Promise.resolve(issue(id)));
  subscribe.mockResolvedValue({ ...NOBODY, subscribed: true });
  unsubscribe.mockResolvedValue(NOBODY);
});

describe('issueCount', () => {
  it('names one issue by its key and more by their count', () => {
    expect(issueCount([issue('a')])).toBe('ENG-a');
    expect(issueCount([issue('a'), issue('b')])).toBe('2 issues');
  });
});

describe('moveOrder', () => {
  it('puts a sub-issue after its parent when both move', () => {
    const child = issue('c', { parent_id: 'p' });
    const parent = issue('p');
    const loose = issue('l', { parent_id: 'elsewhere' });
    expect(moveOrder([child, parent, loose]).map((item) => item.id)).toEqual([
      'p',
      'l',
      'c',
    ]);
  });
});

describe('moveIssues', () => {
  it('moves each issue not already there and names the count', async () => {
    const moved = await moveIssues(
      'ws-1',
      [issue('a'), issue('b'), issue('c', { team_id: 'team-2' })],
      OPS
    );

    expect(moveIssue.mock.calls).toEqual([
      ['ws-1', 'a', 'team-2'],
      ['ws-1', 'b', 'team-2'],
    ]);
    expect(moved.map((item) => item.key)).toEqual(['OPS-a', 'OPS-b']);
    expect(messages()).toContain('Moved 2 issues to Ops');
    expect(canUndo('ws-1')).toBe(true);
  });

  it('names the new key when one issue moves', async () => {
    await moveIssues('ws-1', [issue('a')], OPS);

    expect(messages()).toContain('Moved ENG-a to Ops as OPS-a');
  });

  it('moves every issue back on undo, parents first', async () => {
    await moveIssues('ws-1', [issue('c', { parent_id: 'p' }), issue('p')], OPS);
    moveIssue.mockClear();

    await undoLast('ws-1');

    expect(moveIssue.mock.calls).toEqual([
      ['ws-1', 'p', 'team-1'],
      ['ws-1', 'c', 'team-1'],
    ]);
  });

  it('keeps going past a failed move and says how many missed', async () => {
    moveIssue.mockImplementation((_ws, id, teamId) =>
      id === 'b'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve(issue(id, { team_id: teamId, key: `OPS-${id}` }))
    );

    const moved = await moveIssues(
      'ws-1',
      [issue('a'), issue('b'), issue('c')],
      OPS
    );

    expect(moved).toHaveLength(2);
    expect(messages()).toContain('Moved 2 issues to Ops');
    expect(currentToasts().some((toast) => toast.tone === 'error')).toBe(true);
  });

  it('records nothing when every issue is already there', async () => {
    await moveIssues('ws-1', [issue('a', { team_id: 'team-2' })], OPS);

    expect(moveIssue).not.toHaveBeenCalled();
    expect(canUndo('ws-1')).toBe(false);
  });
});

describe('setSubscriptions', () => {
  it('subscribes the caller to every issue with one notice', async () => {
    await setSubscriptions('ws-1', [issue('a'), issue('b')], true);

    expect(subscribe.mock.calls).toEqual([
      ['ws-1', 'a'],
      ['ws-1', 'b'],
    ]);
    expect(messages()).toEqual(['Subscribed to 2 issues']);
  });

  it('unsubscribes the caller from every issue', async () => {
    await setSubscriptions('ws-1', [issue('a'), issue('b')], false);

    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(messages()).toEqual(['Unsubscribed from 2 issues']);
  });

  it('counts only the issues that took and reports a failure', async () => {
    subscribe.mockImplementation((_ws, id) =>
      id === 'b'
        ? Promise.reject(new Error('nope'))
        : Promise.resolve({ ...NOBODY, subscribed: true })
    );

    await setSubscriptions('ws-1', [issue('a'), issue('b')], true);

    expect(messages()).toContain('Subscribed to ENG-a');
    expect(currentToasts().some((toast) => toast.tone === 'error')).toBe(true);
  });
});
