/**
 * The favorites contract the sidebar and the star toggles depend on: the routes
 * under the workspace, and a listing whose missing body reads as no favorites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addFavorite,
  createFavoriteFolder,
  deleteFavoriteFolder,
  listFavoriteFolders,
  listFavorites,
  removeFavorite,
  renameFavoriteFolder,
  reorderFavorites,
} from './favorites';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const put = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const patch = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();
const del = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown) => post(path, body),
    put: (path: string, body?: unknown) => put(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
    delete: (path: string) => del(path),
  },
}));

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
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

  it('lists folders from the same read and reads a missing body as none', async () => {
    get.mockResolvedValueOnce({
      data: {
        favorites: [],
        folders: [{ folder_id: 'f1', name: 'Launch', position: 0 }],
      },
    });
    get.mockResolvedValueOnce({ data: { favorites: [] } });

    const found = await listFavoriteFolders('ws-1');
    const empty = await listFavoriteFolders('ws-1');

    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/favorites', undefined);
    expect(found.map((row) => row.name)).toEqual(['Launch']);
    expect(empty).toEqual([]);
  });

  it('creates, renames and deletes folders through their own routes', async () => {
    post.mockResolvedValue({
      data: { folder_id: 'f1', name: 'Launch', position: 0 },
    });
    patch.mockResolvedValue({
      data: { folder_id: 'f1', name: 'Ship', position: 0 },
    });
    del.mockResolvedValue({ data: undefined });

    const created = await createFavoriteFolder('ws-1', 'Launch');
    const renamed = await renameFavoriteFolder('ws-1', 'f1', 'Ship');
    await deleteFavoriteFolder('ws-1', 'f1');

    expect(created.folder_id).toBe('f1');
    expect(renamed.name).toBe('Ship');
    expect(post).toHaveBeenCalledWith('/workspaces/ws-1/favorites/folders', {
      name: 'Launch',
    });
    expect(patch).toHaveBeenCalledWith(
      '/workspaces/ws-1/favorites/folders/f1',
      { name: 'Ship' }
    );
    expect(del).toHaveBeenCalledWith('/workspaces/ws-1/favorites/folders/f1');
  });
});
