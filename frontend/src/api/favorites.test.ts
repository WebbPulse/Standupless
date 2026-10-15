/**
 * The favorites contract the sidebar and the star toggles depend on: the routes
 * under the workspace, and a listing whose missing body reads as no favorites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFavorite,
  listFavorites,
  removeFavorite,
  reorderFavorites,
} from './favorites';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const put = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const del = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown) => post(path, body),
    put: (path: string, body?: unknown) => put(path, body),
    delete: (path: string) => del(path),
  },
}));

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  del.mockReset();
});

describe('favorites routes', () => {
  it('lists the workspace favorites and reads a missing body as none', async () => {
    get.mockResolvedValueOnce({
      data: { favorites: [{ kind: 'team', target_id: 't1', title: 'Eng' }] },
    });
    get.mockResolvedValueOnce({ data: undefined });

    const found = await listFavorites('ws-1');
    const empty = await listFavorites('ws-1');

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/favorites', undefined);
    expect(found.map((row) => row.target_id)).toEqual(['t1']);
    expect(empty).toEqual([]);
  });

  it('adds, removes and reorders through their own routes', async () => {
    post.mockResolvedValue({ data: { kind: 'issue', target_id: 'i1' } });
    del.mockResolvedValue({ data: undefined });
    put.mockResolvedValue({ data: { favorites: [] } });

    await addFavorite('ws-1', { kind: 'issue', target_id: 'i1' });
    await removeFavorite('ws-1', 'issue', 'i1');
    await reorderFavorites('ws-1', {
      items: [{ kind: 'team', target_id: 't1' }],
    });

    expect(post).toHaveBeenCalledWith('/workspaces/ws-1/favorites', {
      kind: 'issue',
      target_id: 'i1',
    });
    expect(del).toHaveBeenCalledWith('/workspaces/ws-1/favorites/issue/i1');
    expect(put).toHaveBeenCalledWith('/workspaces/ws-1/favorites/order', {
      items: [{ kind: 'team', target_id: 't1' }],
    });
  });
});
