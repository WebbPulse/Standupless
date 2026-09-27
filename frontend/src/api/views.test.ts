/**
 * The board, saved view, search and inbox contract the frontend depends on:
 * the board as one call per team with the column route for depth, a saved
 * view that never sends its derived scope or owner, search without a cursor,
 * and an inbox whose partition is the caller rather than a parameter. Each is
 * pinned because a wrong path, verb or parameter name type-checks identically
 * and fails only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendNotifications,
  boardColumnPath,
  boardPath,
  createView,
  deleteNotification,
  deleteView,
  emptyInboxPage,
  getBoard,
  getInboxCount,
  getView,
  inboxCountPath,
  inboxPath,
  inboxReadPath,
  listBoardColumn,
  listInbox,
  listViews,
  markAllRead,
  markRead,
  notificationPath,
  search,
  searchPath,
  updateView,
  viewFilterToQuery,
  viewPath,
  viewSort,
  viewsPath,
} from './views';
import type {
  BoardColumnRead,
  IssueRead,
  NotificationRead,
  SavedViewRead,
  SearchResultRead,
} from '../types/Api';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const WS = 'ws-mine';
const TEAM = 'proj-1';

/** One issue, since a board column carries the M2 shape unchanged. */
const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: WS,
  team_id: TEAM,
  key: 'ENG-1',
  number: 1,
  title: 'Boot the engine',
  body: null,
  status_id: 'st-1',
  priority: 'none',
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
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** One board column in exactly the shape the backend serialises. */
const column: BoardColumnRead = {
  status_id: 'st-1',
  name: 'Todo',
  category: 'unstarted',
  position: 0,
  issues: [issue],
  total: 1,
  next_cursor: null,
};

/** One saved view in exactly the shape the backend serialises. */
const view: SavedViewRead = {
  view_id: 'vw-1',
  workspace_id: WS,
  name: 'Urgent work',
  kind: 'list',
  scope: 'personal',
  team_id: null,
  filter: { priority: 'urgent' },
  sort: 'updated_desc',
  group_by: null,
  owner_id: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** One search hit in exactly the shape the backend serialises. */
const hit: SearchResultRead = {
  issue_id: 'iss-1',
  key: 'ENG-1',
  title: 'Boot the engine',
  team_id: TEAM,
  status_id: 'st-1',
  assignee_id: null,
  updated_at: '2026-09-18T00:00:00Z',
  score: 2,
};

/** One inbox row in exactly the shape the backend serialises. */
const notification: NotificationRead = {
  notification_id: 'ntf-1',
  workspace_id: WS,
  kind: 'mentioned',
  issue_id: 'iss-1',
  issue_key: 'ENG-1',
  issue_title: 'Boot the engine',
  team_id: TEAM,
  comment_id: 'cmt-1',
  actor_id: 'user-2',
  actor_name: 'Grace',
  unread: true,
  created_at: '2026-09-18T00:00:00Z',
  expires_at: '2026-12-17T00:00:00Z',
};

beforeEach(() => {
  for (const spy of [get, post, patch, del]) spy.mockReset();
});

describe('the paths', () => {
  it('puts the column route under the board rather than beside it', () => {
    expect(boardPath(WS)).toBe('/workspaces/ws-mine/board');
    expect(boardColumnPath(WS, 'st-1')).toBe(
      '/workspaces/ws-mine/board/columns/st-1'
    );
  });

  it('scopes views, search and the inbox to the workspace', () => {
    expect(viewsPath(WS)).toBe('/workspaces/ws-mine/views');
    expect(viewPath(WS, 'vw-1')).toBe('/workspaces/ws-mine/views/vw-1');
    expect(searchPath(WS)).toBe('/workspaces/ws-mine/search');
    expect(inboxPath(WS)).toBe('/workspaces/ws-mine/inbox');
    expect(inboxCountPath(WS)).toBe('/workspaces/ws-mine/inbox/count');
    expect(inboxReadPath(WS)).toBe('/workspaces/ws-mine/inbox/read');
    expect(notificationPath(WS, 'ntf-1')).toBe(
      '/workspaces/ws-mine/inbox/ntf-1'
    );
  });
});

describe('the board', () => {
  it('requires the team and sends the filters beside it', async () => {
    get.mockResolvedValue({
      data: { team_id: TEAM, columns: [column] },
    });

    const board = await getBoard(WS, TEAM, {
      assignee_id: 'me',
      label_id: 'lb-1',
      priority: 'high',
      column_limit: 25,
    });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/board', {
      query: {
        team_id: TEAM,
        assignee_id: 'me',
        label_id: 'lb-1',
        priority: 'high',
        column_limit: 25,
      },
    });
    expect(board.columns).toEqual([column]);
  });

  it('reads a body missing its envelope as a board with no columns', async () => {
    get.mockResolvedValue({ data: undefined });

    await expect(getBoard(WS, TEAM)).resolves.toEqual({
      team_id: TEAM,
      columns: [],
    });
  });

  it('pages one column on its own route, carrying the same filters', async () => {
    get.mockResolvedValue({ data: { issues: [issue], next_cursor: 'cur-2' } });

    const page = await listBoardColumn(WS, 'st-1', TEAM, {
      priority: 'high',
      cursor: 'cur-1',
      limit: 50,
    });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/board/columns/st-1', {
      query: {
        team_id: TEAM,
        priority: 'high',
        cursor: 'cur-1',
        limit: 50,
      },
    });
    expect(page.issues).toEqual([issue]);
    expect(page.next_cursor).toBe('cur-2');
  });
});

describe('saved views', () => {
  it('lists with the scope the caller asked for', async () => {
    get.mockResolvedValue({ data: { views: [view] } });

    await expect(
      listViews(WS, { scope: 'team', team_id: TEAM })
    ).resolves.toEqual([view]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/views', {
      query: { scope: 'team', team_id: TEAM },
    });
  });

  it('reads a body missing its envelope as no views', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listViews(WS)).resolves.toEqual([]);
  });

  it('creates without sending the derived scope or the owner', async () => {
    post.mockResolvedValue({ data: view });

    await createView(WS, {
      name: 'Urgent work',
      kind: 'list',
      filter: { priority: 'urgent' },
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/views',
      { name: 'Urgent work', kind: 'list', filter: { priority: 'urgent' } },
      undefined
    );
  });

  it('reads one view by id, with no issue list route beside it', async () => {
    get.mockResolvedValue({ data: view });

    await expect(getView(WS, 'vw-1')).resolves.toEqual(view);
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/views/vw-1',
      undefined
    );
  });

  it('patches only the fields it is given', async () => {
    patch.mockResolvedValue({ data: view });

    await updateView(WS, 'vw-1', { name: 'Renamed' });

    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-mine/views/vw-1',
      { name: 'Renamed' },
      undefined
    );
  });

  it('deletes a view', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteView(WS, 'vw-1');

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-mine/views/vw-1',
      undefined
    );
  });
});

describe('search', () => {
  it('sends the term and the optional team, and takes no cursor', async () => {
    get.mockResolvedValue({ data: { results: [hit] } });

    await expect(
      search(WS, 'engine', { team_id: TEAM, limit: 20 })
    ).resolves.toEqual([hit]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/search', {
      query: { q: 'engine', team_id: TEAM, limit: 20 },
    });
  });

  it('reads a body missing its envelope as no results', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(search(WS, 'engine')).resolves.toEqual([]);
  });
});

describe('the inbox', () => {
  it('lists with no recipient parameter, since the caller is the partition', async () => {
    get.mockResolvedValue({
      data: { notifications: [notification], next_cursor: 'cur-2' },
    });

    const page = await listInbox(WS, { unread: true, limit: 50 });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/inbox', {
      query: { unread: true, limit: 50 },
    });
    expect(page.notifications).toEqual([notification]);
    expect(page.next_cursor).toBe('cur-2');
  });

  it('reads a body missing its envelope as an empty page', async () => {
    get.mockResolvedValue({ data: undefined });

    await expect(listInbox(WS)).resolves.toEqual({
      notifications: [],
      next_cursor: null,
    });
  });

  it('reads the badge count off its own route', async () => {
    get.mockResolvedValue({ data: { unread: 7 } });

    await expect(getInboxCount(WS)).resolves.toBe(7);
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/inbox/count',
      undefined
    );
  });

  it('reads a missing count as nothing unread rather than failing', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(getInboxCount(WS)).resolves.toBe(0);
  });

  it('marks named rows read and reports how many changed', async () => {
    post.mockResolvedValue({ data: { updated: 2 } });

    await expect(
      markRead(WS, { notification_ids: ['ntf-1', 'ntf-2'] })
    ).resolves.toBe(2);
    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/inbox/read',
      { notification_ids: ['ntf-1', 'ntf-2'] },
      undefined
    );
  });

  it('marks every row read with the all flag rather than a list', async () => {
    post.mockResolvedValue({ data: { updated: 9 } });

    await expect(markAllRead(WS)).resolves.toBe(9);
    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/inbox/read',
      { all: true },
      undefined
    );
  });

  it('deletes one notification by id', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteNotification(WS, 'ntf-1');

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-mine/inbox/ntf-1',
      undefined
    );
  });
});

describe('the paging helpers', () => {
  it('starts from an empty inbox page', () => {
    expect(emptyInboxPage()).toEqual({
      notifications: [],
      next_cursor: null,
    });
  });

  it('appends without repeating a row the cursor overlapped', () => {
    const second: NotificationRead = {
      ...notification,
      notification_id: 'ntf-2',
    };

    expect(appendNotifications([notification], [notification, second])).toEqual(
      [notification, second]
    );
  });
});

describe('saved view display settings', () => {
  it('sends the display settings and a negated filter on create', async () => {
    post.mockResolvedValue({ data: {} });

    await createView(WS, {
      name: 'Mine',
      kind: 'list',
      filter: { assignee_id: ['me', 'none'], label_id_not: 'lb-1' },
      sort: 'manual',
      group_by: 'status',
      sub_group_by: 'assignee',
      ordering: 'priority_desc',
      visible_properties: ['id', 'priority'],
      layout: 'board',
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/views',
      {
        name: 'Mine',
        kind: 'list',
        filter: { assignee_id: ['me', 'none'], label_id_not: 'lb-1' },
        sort: 'manual',
        group_by: 'status',
        sub_group_by: 'assignee',
        ordering: 'priority_desc',
        visible_properties: ['id', 'priority'],
        layout: 'board',
      },
      undefined
    );
  });

  it('patches only the display fields it is given', async () => {
    patch.mockResolvedValue({ data: {} });

    await updateView(WS, 'view-1', { layout: 'list', ordering: null });

    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-mine/views/view-1',
      { layout: 'list', ordering: null },
      undefined
    );
  });

  it('reads a manual sort off a view', () => {
    const view = { sort: 'manual' } as unknown as Parameters<
      typeof viewSort
    >[0];

    expect(viewSort(view)).toBe('manual');
  });
});

describe('running a saved view', () => {
  it('expands the stored filter into the list query, lists kept as lists', () => {
    const query = viewFilterToQuery(
      {
        team_id: 'team-1',
        status_category: ['started', 'unstarted'],
        assignee_id: 'me',
        priority_not: ['low'],
        q: 'engine',
      },
      'manual'
    );

    expect(query).toEqual({
      team_id: 'team-1',
      status_category: ['started', 'unstarted'],
      assignee_id: 'me',
      priority_not: ['low'],
      q: 'engine',
      sort: 'manual',
    });
  });

  it('keeps the first value of a list on a key the list takes once', () => {
    const query = viewFilterToQuery({ team_id: ['team-1', 'team-2'] });

    expect(query).toEqual({ team_id: 'team-1' });
  });

  it('copies list values, so editing the query never edits the view', () => {
    const filter = { label_id: ['lb-1'] };
    const query = viewFilterToQuery(filter);

    expect(query.label_id).toEqual(['lb-1']);
    expect(query.label_id).not.toBe(filter.label_id);
  });
});
