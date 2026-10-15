/**
 * The conditional lookup reads. Handed a polled query's context, a read sends
 * the held ETag and answers a `PolledResponse`, so a quiet poll is a bodiless
 * 304 the cache keeps its data through. Handed a bare signal, the same read
 * answers the shaped body exactly as before, which every other caller relies on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PolledResponse,
  type PolledQueryContext,
} from '@webbpulse/api-client/react';
import { isPolledContext } from './conditional';
import { getIssue, getIssueByKey } from './issues';
import {
  labelsPath,
  listLabels,
  listStatuses,
  listTeamMembers,
  listTeams,
  statusesPath,
  teamMembersPath,
  teamsPath,
} from './teams';
import { listViews } from './views';
import { listMembers } from './workspaces';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
  },
}));

const WS = 'ws-mine';
const TEAM = 'team-1';
const TAG = 'W/"abc"';

/** Response headers that answer only the ETag, the one header a read uses. */
const headersWith = (etag: string | null): Pick<Headers, 'get'> => ({
  get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null),
});

/** A polled query's context holding `etag`, or none. */
const contextHolding = (etag?: string): PolledQueryContext => ({
  signal: new AbortController().signal,
  etag,
  headers: etag === undefined ? {} : { 'If-None-Match': etag },
});

beforeEach(() => {
  get.mockReset();
});

describe('telling a polled context from a signal', () => {
  it('treats nothing and a bare signal as the plain read', () => {
    expect(isPolledContext(undefined)).toBe(false);
    expect(isPolledContext(new AbortController().signal)).toBe(false);
    expect(isPolledContext(contextHolding())).toBe(true);
  });
});

describe('a read handed a bare signal', () => {
  it('answers the shaped body and sends no conditional header', async () => {
    const controller = new AbortController();
    get.mockResolvedValue({
      status: 200,
      headers: headersWith(TAG),
      data: { teams: [{ id: TEAM }] },
    });

    await expect(listTeams(WS, controller.signal)).resolves.toEqual([
      { id: TEAM },
    ]);
    expect(get).toHaveBeenCalledWith(teamsPath(WS), {
      signal: controller.signal,
    });
  });
});

describe('a read handed a polled context', () => {
  it('sends the held tag and answers the shaped body with its new tag', async () => {
    get.mockResolvedValue({
      status: 200,
      headers: headersWith('W/"next"'),
      data: { teams: [{ id: TEAM }] },
    });
    const context = contextHolding(TAG);

    const answer = await listTeams(WS, context);

    expect(answer).toBeInstanceOf(PolledResponse);
    expect(answer.data).toEqual([{ id: TEAM }]);
    expect(answer.etag).toBe('W/"next"');
    expect(answer.notModified).toBe(false);
    expect(get).toHaveBeenCalledWith(teamsPath(WS), {
      signal: context.signal,
      headers: { 'If-None-Match': TAG },
    });
  });

  it('answers a 304 as not modified, without a body', async () => {
    get.mockResolvedValue({
      status: 304,
      headers: headersWith(TAG),
      data: '',
    });

    const answer = await listStatuses(WS, TEAM, contextHolding(TAG));

    expect(answer.notModified).toBe(true);
    expect(answer.data).toBeUndefined();
    expect(answer.etag).toBe(TAG);
    expect(get).toHaveBeenCalledWith(
      statusesPath(WS, TEAM),
      expect.objectContaining({ headers: { 'If-None-Match': TAG } })
    );
  });

  it('keeps the list options alongside the conditional header', async () => {
    get.mockResolvedValue({
      status: 200,
      headers: headersWith(TAG),
      data: { labels: [] },
    });
    const context = contextHolding(TAG);

    await listLabels(WS, TEAM, context, { includeHidden: true });

    expect(get).toHaveBeenCalledWith(labelsPath(WS, TEAM), {
      query: { include_hidden: true },
      signal: context.signal,
      headers: { 'If-None-Match': TAG },
    });
  });

  it('sends no conditional header before a tag is held', async () => {
    get.mockResolvedValue({
      status: 200,
      headers: headersWith(TAG),
      data: { members: [{ user_id: 'u-1' }] },
    });
    const context = contextHolding();

    const answer = await listTeamMembers(WS, TEAM, context);

    expect(answer.data).toEqual([{ user_id: 'u-1' }]);
    expect(get).toHaveBeenCalledWith(teamMembersPath(WS, TEAM), {
      signal: context.signal,
      headers: {},
    });
  });

  it('reads workspace members, saved views and one issue the same way', async () => {
    get.mockImplementation((path: string) =>
      Promise.resolve({
        status: 200,
        headers: headersWith(TAG),
        data: path.endsWith('/members')
          ? { members: [{ user_id: 'u-1' }] }
          : path.endsWith('/views')
            ? { views: [{ id: 'v-1' }] }
            : { id: 'iss-1', key: 'ENG-1' },
      })
    );

    const members = await listMembers(WS, contextHolding(TAG));
    const views = await listViews(WS, { scope: 'all' }, contextHolding(TAG));
    const byId = await getIssue(WS, 'iss-1', contextHolding(TAG));
    const byKey = await getIssueByKey(WS, 'ENG-1', contextHolding(TAG));

    expect(members.data).toEqual([{ user_id: 'u-1' }]);
    expect(views.data).toEqual([{ id: 'v-1' }]);
    expect(byId.data).toEqual({ id: 'iss-1', key: 'ENG-1' });
    expect(byKey.data).toEqual({ id: 'iss-1', key: 'ENG-1' });
    for (const call of get.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({ headers: { 'If-None-Match': TAG } })
      );
    }
  });
});
