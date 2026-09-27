/**
 * The issue, link and activity contract the frontend depends on: workspace
 * scoped paths with the team as a filter rather than a segment, cursor pages
 * carrying `next_cursor`, and the `me` literal on the assignee filter. Each is
 * pinned because a wrong path, verb or parameter name type-checks identically
 * and fails only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BULK_MAX_ISSUES,
  ME,
  NONE,
  appendActivity,
  bulkUpdateIssues,
  appendIssues,
  createIssue,
  createLink,
  deleteIssue,
  deleteLink,
  emptyActivityPage,
  emptyPage,
  getIssue,
  getIssueByKey,
  issueActivityPath,
  issueByKeyPath,
  issueChildrenPath,
  issueLinksPath,
  issuePath,
  issuesPath,
  listActivity,
  listChildren,
  listIssues,
  listLinks,
  orderBetween,
  updateIssue,
} from './issues';
import type { ActivityRead, IssueRead, LinkRead } from '../types/Api';

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
const ISSUE = 'iss-1';

/** One issue row in exactly the shape the backend serialises. */
const issue: IssueRead = {
  id: ISSUE,
  workspace_id: WS,
  team_id: 'proj-1',
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
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** One link row in exactly the shape the backend serialises. */
const link: LinkRead = {
  link_id: 'lnk-1',
  issue_id: ISSUE,
  type: 'blocks',
  target_issue_id: 'iss-2',
  target_key: 'ENG-2',
  target_title: 'Fuel it',
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
};

/** One activity row in exactly the shape the backend serialises. */
const entry: ActivityRead = {
  activity_id: 'act-1',
  issue_id: ISSUE,
  actor_id: 'user-1',
  actor_kind: 'user',
  kind: 'created',
  field: null,
  from: null,
  to: null,
  created_at: '2026-09-17T00:00:00Z',
};

beforeEach(() => {
  for (const spy of [get, post, patch, del]) spy.mockReset();
});

describe('the paths', () => {
  it('scopes every route to the workspace, with no team segment', () => {
    expect(issuesPath(WS)).toBe('/workspaces/ws-mine/issues');
    expect(issuePath(WS, ISSUE)).toBe('/workspaces/ws-mine/issues/iss-1');
    expect(issueChildrenPath(WS, ISSUE)).toBe(
      '/workspaces/ws-mine/issues/iss-1/children'
    );
    expect(issueLinksPath(WS, ISSUE)).toBe(
      '/workspaces/ws-mine/issues/iss-1/links'
    );
    expect(issueActivityPath(WS, ISSUE)).toBe(
      '/workspaces/ws-mine/issues/iss-1/activity'
    );
  });

  it('escapes the key, which arrives from the address bar', () => {
    expect(issueByKeyPath(WS, 'ENG-12')).toBe(
      '/workspaces/ws-mine/issues/by-key/ENG-12'
    );
    expect(issueByKeyPath(WS, 'a/b')).toBe(
      '/workspaces/ws-mine/issues/by-key/a%2Fb'
    );
  });
});

describe('listing issues', () => {
  it('sends every filter as a query parameter and reads the page back', async () => {
    get.mockResolvedValue({
      data: { issues: [issue], next_cursor: 'cur-2' },
    });

    const page = await listIssues(WS, {
      team_id: 'proj-1',
      status_id: 'st-1',
      assignee_id: ME,
      label_id: 'lb-1',
      priority: 'high',
      q: 'engine',
      sort: 'key_asc',
      cursor: 'cur-1',
      limit: 25,
    });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/issues', {
      query: {
        team_id: 'proj-1',
        status_id: 'st-1',
        assignee_id: 'me',
        label_id: 'lb-1',
        priority: 'high',
        q: 'engine',
        sort: 'key_asc',
        cursor: 'cur-1',
        limit: 25,
      },
    });
    expect(page.issues).toEqual([issue]);
    expect(page.next_cursor).toBe('cur-2');
  });

  it('omits the team filter for a cross-team read', async () => {
    get.mockResolvedValue({ data: { issues: [], next_cursor: null } });

    await listIssues(WS, { assignee_id: ME });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/issues', {
      query: { assignee_id: 'me' },
    });
  });

  it('passes an abort signal through beside the query', async () => {
    get.mockResolvedValue({ data: { issues: [], next_cursor: null } });
    const signal = new AbortController().signal;

    await listIssues(WS, { q: 'x' }, signal);

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/issues', {
      query: { q: 'x' },
      signal,
    });
  });

  it('reads a body missing its envelope as an empty page', async () => {
    get.mockResolvedValue({ data: undefined });

    await expect(listIssues(WS)).resolves.toEqual({
      issues: [],
      next_cursor: null,
    });
  });
});

describe('the single issue routes', () => {
  it('reads one issue by id', async () => {
    get.mockResolvedValue({ data: issue });

    await expect(getIssue(WS, ISSUE)).resolves.toEqual(issue);
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1',
      undefined
    );
  });

  it('reads one issue by key', async () => {
    get.mockResolvedValue({ data: issue });

    await expect(getIssueByKey(WS, 'eng-1')).resolves.toEqual(issue);
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/by-key/eng-1',
      undefined
    );
  });

  it('creates an issue with the team as a body field', async () => {
    post.mockResolvedValue({ data: issue });

    await createIssue(WS, { team_id: 'proj-1', title: 'Boot the engine' });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues',
      { team_id: 'proj-1', title: 'Boot the engine' },
      undefined
    );
  });

  it('patches only the fields it is given', async () => {
    patch.mockResolvedValue({ data: issue });

    await updateIssue(WS, ISSUE, { status_id: 'st-2' });

    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1',
      { status_id: 'st-2' },
      undefined
    );
  });

  it('deletes an issue', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteIssue(WS, ISSUE);

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1',
      undefined
    );
  });
});

describe('children, links and activity', () => {
  it('pages the children route', async () => {
    get.mockResolvedValue({ data: { issues: [issue], next_cursor: null } });

    const page = await listChildren(WS, ISSUE, { cursor: 'c', limit: 10 });

    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1/children',
      { query: { cursor: 'c', limit: 10 } }
    );
    expect(page.issues).toEqual([issue]);
  });

  it('reads links out of their plural envelope', async () => {
    get.mockResolvedValue({ data: { links: [link] } });

    await expect(listLinks(WS, ISSUE)).resolves.toEqual([link]);
  });

  it('reads a link body missing its envelope as no links', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listLinks(WS, ISSUE)).resolves.toEqual([]);
  });

  it('adds a link by target id and type', async () => {
    post.mockResolvedValue({ data: link });

    await createLink(WS, ISSUE, { type: 'blocks', target_issue_id: 'iss-2' });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1/links',
      { type: 'blocks', target_issue_id: 'iss-2' },
      undefined
    );
  });

  it('removes a link by its stable link id', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteLink(WS, ISSUE, 'lnk-1');

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1/links/lnk-1',
      undefined
    );
  });

  it('pages the activity route, which answers its own plural key', async () => {
    get.mockResolvedValue({
      data: { activity: [entry], next_cursor: 'cur-2' },
    });

    const page = await listActivity(WS, ISSUE, { limit: 50 });

    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1/activity',
      { query: { limit: 50 } }
    );
    expect(page.activity).toEqual([entry]);
    expect(page.next_cursor).toBe('cur-2');
  });

  it('reads an activity body missing its envelope as an empty page', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listActivity(WS, ISSUE)).resolves.toEqual({
      activity: [],
      next_cursor: null,
    });
  });
});

describe('the paging helpers', () => {
  it('starts from an empty page of each kind', () => {
    expect(emptyPage()).toEqual({ issues: [], next_cursor: null });
    expect(emptyActivityPage()).toEqual({ activity: [], next_cursor: null });
  });

  it('appends a page without repeating a row the cursor overlapped', () => {
    const second: IssueRead = { ...issue, id: 'iss-2', key: 'ENG-2' };

    expect(
      appendIssues([issue], { issues: [issue, second], next_cursor: null })
    ).toEqual([issue, second]);
  });

  it('appends activity without repeating an entry', () => {
    const second: ActivityRead = { ...entry, activity_id: 'act-2' };

    expect(
      appendActivity([entry], {
        activity: [entry, second],
        next_cursor: null,
      })
    ).toEqual([entry, second]);
  });
});

describe('multi-value filters', () => {
  it('passes arrays through, which the client sends as repeated keys', async () => {
    get.mockResolvedValue({ data: { issues: [], next_cursor: null } });

    await listIssues(WS, {
      status_category: ['started', 'unstarted'],
      assignee_id: [ME, NONE],
      label_id_not: ['lb-wontfix'],
      priority: ['urgent', 'high'],
      project_id: NONE,
      sort: 'manual',
    });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-mine/issues', {
      query: {
        status_category: ['started', 'unstarted'],
        assignee_id: ['me', 'none'],
        label_id_not: ['lb-wontfix'],
        priority: ['urgent', 'high'],
        project_id: 'none',
        sort: 'manual',
      },
    });
  });
});

describe('bulk update', () => {
  it('patches the workspace issue collection with the ids and one patch', async () => {
    patch.mockResolvedValue({ data: { issues: [issue], skipped: ['gone'] } });

    const result = await bulkUpdateIssues(WS, {
      issue_ids: [ISSUE, 'gone'],
      patch: { priority: 'low', add_label_ids: ['lb-1'], assignee_id: null },
    });

    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues',
      {
        issue_ids: [ISSUE, 'gone'],
        patch: { priority: 'low', add_label_ids: ['lb-1'], assignee_id: null },
      },
      undefined
    );
    expect(result).toEqual({ issues: [issue], skipped: ['gone'] });
  });

  it('reads a body missing its envelope as nothing changed', async () => {
    patch.mockResolvedValue({ data: undefined });

    const result = await bulkUpdateIssues(WS, {
      issue_ids: [ISSUE],
      patch: { priority: 'low' },
    });

    expect(result).toEqual({ issues: [], skipped: [] });
  });

  it('caps a batch where the server does', () => {
    expect(BULK_MAX_ISSUES).toBe(50);
  });
});

describe('manual order', () => {
  it('sends a sort_order on the single patch', async () => {
    patch.mockResolvedValue({ data: issue });

    await updateIssue(WS, ISSUE, { sort_order: 'aV' });

    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-mine/issues/iss-1',
      { sort_order: 'aV' },
      undefined
    );
  });

  it('places a key strictly between its neighbours', () => {
    const cases: [string | null, string | null][] = [
      [null, null],
      ['a', 'b'],
      ['a', null],
      [null, '0V'],
      ['z', null],
      ['aV', 'aW'],
    ];
    for (const [before, after] of cases) {
      const key = orderBetween(before, after);
      expect(key).toMatch(/^[0-9A-Za-z]+$/);
      if (before !== null) {
        expect(key > before).toBe(true);
      }
      if (after !== null) {
        expect(key < after).toBe(true);
      }
    }
    expect(orderBetween('a', 'b')).toBe('aV');
  });

  it('refuses neighbours out of order, or a key nothing sorts ahead of', () => {
    expect(() => orderBetween('b', 'a')).toThrow();
    expect(() => orderBetween(null, '0')).toThrow();
  });
});
