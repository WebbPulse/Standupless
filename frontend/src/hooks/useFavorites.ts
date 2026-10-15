/**
 * The caller's favorites with optimistic writes. Under the workspace layout the
 * sidebar provider holds one copy, so starring on a page lights up the sidebar
 * at once; anywhere else, such as a component rendered on its own in a test,
 * the hook reads for itself.
 */

import { useCallback, useContext, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  invalidateQueries,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import {
  addFavorite,
  listFavorites,
  removeFavorite,
  reorderFavorites,
} from '../api/favorites';
import { SidebarDataContext } from '../contexts/SidebarDataContextDefinition';
import { errorMessage } from '../lib/errors';
import { sameFavorite, type FavoritesState } from '../lib/favorites';
import { favoritesKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type { FavoriteKind, FavoriteRead, FavoriteRef } from '../types/Api';

/** How often the favorites read repeats. */
export const FAVORITES_POLL_MS = 60000;

/** A pending optimistic list, remembered with the read it was laid over. */
interface Overlay {
  base: FavoriteRead[] | null;
  rows: FavoriteRead[];
}

/**
 * Builds favorites state over one read. An optimistic list stands in until the
 * read changes, so the next answer from the server always wins, and a failed
 * write drops the overlay and says so.
 */
export const useFavoritesState = (
  workspaceId: string,
  enabled: boolean
): FavoritesState => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) => listFavorites(workspaceId, signal),
    {
      intervalMs: FAVORITES_POLL_MS,
      enabled: enabled && workspaceId !== '',
      queryKey: favoritesKey(workspaceId),
      auth,
    }
  );
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const favorites =
    overlay !== null && overlay.base === data ? overlay.rows : data;

  const settle = useCallback(
    async (
      rows: FavoriteRead[],
      write: () => Promise<unknown>
    ): Promise<boolean> => {
      setOverlay({ base: data, rows });
      try {
        await write();
        return true;
      } catch (failure) {
        setOverlay(null);
        showErrorToast(errorMessage(failure, 'Could not change favorites.'));
        return false;
      } finally {
        invalidateQueries(favoritesKey(workspaceId));
      }
    },
    [data, workspaceId]
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
      await settle(rows, () => removeFavorite(workspaceId, kind, targetId));
    },
    [favorites, settle, workspaceId]
  );

  const toggle = useCallback(
    async (ref: FavoriteRef, title: string): Promise<boolean> => {
      if (isFavorite(ref.kind, ref.target_id)) {
        const removed = await settle(
          (favorites ?? []).filter(
            (row) => !sameFavorite(row, ref.kind, ref.target_id)
          ),
          () => removeFavorite(workspaceId, ref.kind, ref.target_id)
        );
        return !removed;
      }
      const row: FavoriteRead = {
        kind: ref.kind,
        target_id: ref.target_id,
        team_id: ref.team_id ?? null,
        title,
      };
      return settle([...(favorites ?? []), row], () =>
        addFavorite(workspaceId, ref)
      );
    },
    [favorites, isFavorite, settle, workspaceId]
  );

  const reorder = useCallback(
    async (next: FavoriteRead[]): Promise<void> => {
      await settle(next, () =>
        reorderFavorites(workspaceId, {
          items: next.map((row) => ({
            kind: row.kind,
            target_id: row.target_id,
            team_id: row.team_id ?? null,
          })),
        })
      );
    },
    [settle, workspaceId]
  );

  return useMemo(
    () => ({ favorites, isFavorite, toggle, remove, reorder }),
    [favorites, isFavorite, toggle, remove, reorder]
  );
};

/** The caller's favorites in `workspaceId`, shared with the sidebar when it is mounted. */
export const useFavorites = (workspaceId: string): FavoritesState => {
  const shared = useContext(SidebarDataContext);
  const reads = shared === undefined || shared.workspaceId !== workspaceId;
  const own = useFavoritesState(workspaceId, reads);
  return reads || shared === undefined ? own : shared.favorites;
};
