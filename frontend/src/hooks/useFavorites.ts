/**
 * The caller's favorites with optimistic writes. Under the workspace layout the
 * sidebar provider holds one copy, so starring on a page lights up the sidebar
 * at once; anywhere else, such as a component rendered on its own in a test,
 * the hook reads for itself.
 */

import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  addFavorite,
  createFavoriteFolder,
  deleteFavoriteFolder,
  listFavoriteFolders,
  listFavorites,
  removeFavorite,
  renameFavoriteFolder,
  reorderFavorites,
} from '../api/favorites';
import { SidebarDataContext } from '../contexts/SidebarDataContextDefinition';
import { errorMessage } from '../lib/errors';
import {
  sameFavorite,
  type FavoritePreview,
  type FavoritesState,
} from '../lib/favorites';
import { favoriteFoldersKey, favoritesKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type {
  FavoriteFolderRead,
  FavoriteKind,
  FavoriteRead,
  FavoriteRef,
} from '../types/Api';

/** How often the favorites read repeats. */
export const FAVORITES_POLL_MS = 60000;

/** Optimistic favorites and folders, with when their write finished or null while it is in flight. */
interface Overlay {
  id: number;
  rows: FavoriteRead[] | null;
  folders: FavoriteFolderRead[] | null;
  settledAt: number | null;
}

/** Whether an overlay still stands in for a read last answered at `readAt`. */
const stands = (overlay: Overlay, readAt: number | null): boolean =>
  overlay.settledAt === null || readAt === null || readAt <= overlay.settledAt;

/** The reorder payload for favorites in `rows` order, each naming its folder. */
const orderOf = (rows: readonly FavoriteRead[]): FavoriteRef[] =>
  rows.map((row) => ({
    kind: row.kind,
    target_id: row.target_id,
    team_id: row.team_id ?? null,
    folder_id: row.folder_id ?? null,
  }));

/**
 * Builds favorites state over one read. An optimistic list stands in while its
 * write is in flight and until a read lands after the write finished, so a poll
 * mid-write never flickers the old list back and the server's next answer
 * still wins. A failed write drops the overlay and says so.
 */
export const useFavoritesState = (
  workspaceId: string,
  enabled: boolean
): FavoritesState => {
  const auth = useQueryAuth();
  const { data, lastUpdatedAt } = usePolledQuery(
    ({ signal }) => listFavorites(workspaceId, signal),
    {
      intervalMs: FAVORITES_POLL_MS,
      enabled: enabled && workspaceId !== '',
      queryKey: favoritesKey(workspaceId),
      auth,
    }
  );
  const folderRead = usePolledQuery(
    ({ signal }) => listFavoriteFolders(workspaceId, signal),
    {
      intervalMs: FAVORITES_POLL_MS,
      enabled: enabled && workspaceId !== '',
      queryKey: favoriteFoldersKey(workspaceId),
      auth,
    }
  );
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const writes = useRef(0);
  const favorites =
    overlay !== null && overlay.rows !== null && stands(overlay, lastUpdatedAt)
      ? overlay.rows
      : data;
  const folders =
    overlay !== null &&
    overlay.folders !== null &&
    stands(overlay, folderRead.lastUpdatedAt)
      ? overlay.folders
      : folderRead.data;

  const settle = useCallback(
    async (
      shown: { rows?: FavoriteRead[]; folders?: FavoriteFolderRead[] },
      write: () => Promise<unknown>
    ): Promise<boolean> => {
      writes.current += 1;
      const id = writes.current;
      setOverlay({
        id,
        rows: shown.rows ?? favorites,
        folders: shown.folders ?? folders,
        settledAt: null,
      });
      try {
        await write();
        const settledAt = Date.now();
        setOverlay((current) =>
          current?.id === id ? { ...current, settledAt } : current
        );
        return true;
      } catch (failure) {
        setOverlay((current) => (current?.id === id ? null : current));
        showErrorToast(errorMessage(failure, 'Could not change favorites.'));
        return false;
      } finally {
        invalidateQueries(favoritesKey(workspaceId));
        invalidateQueries(favoriteFoldersKey(workspaceId));
      }
    },
    [favorites, folders, workspaceId]
  );

  const isFavorite = useCallback(
    (kind: FavoriteKind, targetId: string): boolean =>
      (favorites ?? []).some((row) => sameFavorite(row, kind, targetId)),
    [favorites]
  );

  const remove = useCallback(
    async (kind: FavoriteKind, targetId: string): Promise<void> => {
      const rows = (favorites ?? []).filter(
        (row) => !sameFavorite(row, kind, targetId)
      );
      await settle({ rows }, () => removeFavorite(workspaceId, kind, targetId));
    },
    [favorites, settle, workspaceId]
  );

  const toggle = useCallback(
    async (
      ref: FavoriteRef,
      title: string,
      preview: FavoritePreview = {}
    ): Promise<boolean> => {
      if (isFavorite(ref.kind, ref.target_id)) {
        const removed = await settle(
          {
            rows: (favorites ?? []).filter(
              (row) => !sameFavorite(row, ref.kind, ref.target_id)
            ),
          },
          () => removeFavorite(workspaceId, ref.kind, ref.target_id)
        );
        return !removed;
      }
      const row: FavoriteRead = {
        ...preview,
        kind: ref.kind,
        target_id: ref.target_id,
        team_id: ref.team_id ?? null,
        title,
      };
      return settle({ rows: [...(favorites ?? []), row] }, () =>
        addFavorite(workspaceId, ref)
      );
    },
    [favorites, isFavorite, settle, workspaceId]
  );

  const reorder = useCallback(
    async (next: FavoriteRead[]): Promise<void> => {
      await settle({ rows: next }, () =>
        reorderFavorites(workspaceId, { items: orderOf(next) })
      );
    },
    [settle, workspaceId]
  );

  const createFolder = useCallback(
    async (name: string): Promise<FavoriteFolderRead | null> => {
      let created: FavoriteFolderRead | null = null;
      await settle({}, async () => {
        created = await createFavoriteFolder(workspaceId, name);
        const folder = created;
        setOverlay((current) =>
          current === null
            ? current
            : { ...current, folders: [...(current.folders ?? []), folder] }
        );
      });
      return created;
    },
    [settle, workspaceId]
  );

  const renameFolder = useCallback(
    async (folderId: string, name: string): Promise<void> => {
      await settle(
        {
          folders: (folders ?? []).map((folder) =>
            folder.folder_id === folderId ? { ...folder, name } : folder
          ),
        },
        () => renameFavoriteFolder(workspaceId, folderId, name)
      );
    },
    [folders, settle, workspaceId]
  );

  const deleteFolder = useCallback(
    async (folderId: string): Promise<void> => {
      await settle(
        {
          folders: (folders ?? []).filter(
            (folder) => folder.folder_id !== folderId
          ),
          rows: (favorites ?? []).map((row) =>
            row.folder_id === folderId ? { ...row, folder_id: null } : row
          ),
        },
        () => deleteFavoriteFolder(workspaceId, folderId)
      );
    },
    [favorites, folders, settle, workspaceId]
  );

  const reorderFolders = useCallback(
    async (next: FavoriteFolderRead[]): Promise<void> => {
      await settle(
        {
          folders: next.map((folder, position) => ({ ...folder, position })),
        },
        () =>
          reorderFavorites(workspaceId, {
            items: [],
            folders: next.map((folder) => folder.folder_id),
          })
      );
    },
    [settle, workspaceId]
  );

  return useMemo(
    () => ({
      favorites,
      isFavorite,
      toggle,
      remove,
      reorder,
      folders,
      createFolder,
      renameFolder,
      deleteFolder,
      reorderFolders,
    }),
    [
      favorites,
      isFavorite,
      toggle,
      remove,
      reorder,
      folders,
      createFolder,
      renameFolder,
      deleteFolder,
      reorderFolders,
    ]
  );
};

/** The caller's favorites in `workspaceId`, shared with the sidebar when it is mounted. */
export const useFavorites = (workspaceId: string): FavoritesState => {
  const shared = useContext(SidebarDataContext);
  const reads = shared === undefined || shared.workspaceId !== workspaceId;
  const own = useFavoritesState(workspaceId, reads);
  return reads || shared === undefined ? own : shared.favorites;
};
