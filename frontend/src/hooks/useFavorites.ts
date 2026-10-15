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
  listFavorites,
  removeFavorite,
  reorderFavorites,
} from '../api/favorites';
import { SidebarDataContext } from '../contexts/SidebarDataContextDefinition';
import { errorMessage } from '../lib/errors';
import {
  sameFavorite,
  type FavoritePreview,
  type FavoritesState,
} from '../lib/favorites';
import { favoritesKey } from '../lib/queryKeys';
import { showErrorToast } from '../lib/toast';
import type { FavoriteKind, FavoriteRead, FavoriteRef } from '../types/Api';

/** How often the favorites read repeats. */
export const FAVORITES_POLL_MS = 60000;

/** An optimistic list, with when its write finished or null while it is in flight. */
interface Overlay {
  id: number;
  rows: FavoriteRead[];
  settledAt: number | null;
}

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
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const writes = useRef(0);
  const favorites =
    overlay !== null &&
    (overlay.settledAt === null ||
      lastUpdatedAt === null ||
      lastUpdatedAt <= overlay.settledAt)
      ? overlay.rows
      : data;

  const settle = useCallback(
    async (
      rows: FavoriteRead[],
      write: () => Promise<unknown>
    ): Promise<boolean> => {
      writes.current += 1;
      const id = writes.current;
      setOverlay({ id, rows, settledAt: null });
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
      }
    },
    [workspaceId]
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
    async (
      ref: FavoriteRef,
      title: string,
      preview: FavoritePreview = {}
    ): Promise<boolean> => {
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
        ...preview,
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
