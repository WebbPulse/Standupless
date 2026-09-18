/**
 * The workspace list contract the frontend depends on: the backend answers the
 * `{"workspaces": [...]}` envelope, and this reads the items out of it. The
 * envelope is pinned here because a bare array would type-check identically at
 * the call site and fail only at runtime.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaces, WORKSPACES_PATH } from './workspaces';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
  },
}));

/** One workspace row in exactly the shape the backend serialises. */
const row = {
  id: 'ws-mine',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
};

describe('listWorkspaces', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('reads the items out of the envelope', async () => {
    get.mockResolvedValue({ data: { workspaces: [row] } });

    await expect(listWorkspaces()).resolves.toEqual([row]);
  });

  it('asks for the workspaces route', async () => {
    get.mockResolvedValue({ data: { workspaces: [] } });

    await listWorkspaces();

    expect(get).toHaveBeenCalledWith(WORKSPACES_PATH, undefined);
  });

  it('passes an abort signal through when one is given', async () => {
    get.mockResolvedValue({ data: { workspaces: [] } });
    const controller = new AbortController();

    await listWorkspaces(controller.signal);

    expect(get).toHaveBeenCalledWith(WORKSPACES_PATH, {
      signal: controller.signal,
    });
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listWorkspaces()).resolves.toEqual([]);
  });

  it('answers an empty list rather than throwing on a bare array body', async () => {
    get.mockResolvedValue({ data: [row] });

    await expect(listWorkspaces()).resolves.toEqual([]);
  });
});
