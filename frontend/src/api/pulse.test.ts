/**
 * The Pulse contract the page, the sidebar badge and the follow button depend
 * on: the routes under the workspace, the scope and cursor riding in the query,
 * and bodies whose missing fields fall back rather than break the feed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getFollow,
  getPulseCount,
  initiativeFollowRoute,
  listPulse,
  markPulseRead,
  projectFollowRoute,
  pulseCountRoute,
  pulseReadRoute,
  pulseRoute,
  setFollow,
} from './pulse';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const put = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const remove = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, options?: unknown) => post(path, options),
    put: (path: string, options?: unknown) => put(path, options),
    delete: (path: string, options?: unknown) => remove(path, options),
  },
}));

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  remove.mockReset();
});

describe('the Pulse routes', () => {
  it('sit under the workspace and its projects and initiatives', () => {
    expect(pulseRoute('ws-1')).toBe('/workspaces/ws-1/pulse');
    expect(pulseCountRoute('ws-1')).toBe('/workspaces/ws-1/pulse/count');
    expect(pulseReadRoute('ws-1')).toBe('/workspaces/ws-1/pulse/read');
    expect(projectFollowRoute('ws-1', 'p-1')).toBe(
      '/workspaces/ws-1/projects/p-1/follow'
    );
    expect(initiativeFollowRoute('ws-1', 'i-1')).toBe(
      '/workspaces/ws-1/initiatives/i-1/follow'
    );
  });
});

describe('listPulse', () => {
  it('sends the scope and cursor in the query and passes the page through', async () => {
    get.mockResolvedValue({ data: { items: [], next_cursor: 'next' } });

    const page = await listPulse('ws-1', { scope: 'recent', cursor: 'c' });

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/pulse', {
      query: { scope: 'recent', cursor: 'c' },
    });
    expect(page).toEqual({ items: [], next_cursor: 'next' });
  });

  it('reads a missing body as an empty last page', async () => {
    get.mockResolvedValue({ data: undefined });

    expect(await listPulse('ws-1')).toEqual({ items: [], next_cursor: null });
  });
});

describe('getPulseCount', () => {
  it('answers the unread count, zero when the body is missing', async () => {
    get.mockResolvedValueOnce({ data: { unread: 4 } });
    get.mockResolvedValueOnce({ data: undefined });

    expect(await getPulseCount('ws-1')).toBe(4);
    expect(await getPulseCount('ws-1')).toBe(0);
    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/pulse/count', undefined);
  });
});

describe('markPulseRead', () => {
  it('posts to the read route', async () => {
    post.mockResolvedValue({ data: { read_at: '2026-10-15T08:00:00Z' } });

    expect(await markPulseRead('ws-1')).toEqual({
      read_at: '2026-10-15T08:00:00Z',
    });
    expect(post).toHaveBeenCalledWith('/workspaces/ws-1/pulse/read', undefined);
  });
});

describe('follows', () => {
  it('reads a project follow and an initiative follow on their own routes', async () => {
    get.mockResolvedValue({ data: { following: true, explicit: false } });

    await getFollow('ws-1', 'project', 'p-1');
    await getFollow('ws-1', 'initiative', 'i-1');

    expect(get).toHaveBeenNthCalledWith(
      1,
      '/workspaces/ws-1/projects/p-1/follow',
      undefined
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      '/workspaces/ws-1/initiatives/i-1/follow',
      undefined
    );
  });

  it('follows with a put and unfollows with a delete', async () => {
    put.mockResolvedValue({ data: { following: true, explicit: true } });
    remove.mockResolvedValue({ data: { following: false, explicit: true } });

    expect(await setFollow('ws-1', 'project', 'p-1', true)).toEqual({
      following: true,
      explicit: true,
    });
    expect(await setFollow('ws-1', 'initiative', 'i-1', false)).toEqual({
      following: false,
      explicit: true,
    });
    expect(put).toHaveBeenCalledWith(
      '/workspaces/ws-1/projects/p-1/follow',
      undefined
    );
    expect(remove).toHaveBeenCalledWith(
      '/workspaces/ws-1/initiatives/i-1/follow',
      undefined
    );
  });
});
