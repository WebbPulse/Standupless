/**
 * The favorites routes: what the caller starred, in the order the sidebar shows
 * it. Favorites are the caller's own, and each read resolves every favorite
 * against what they can see now, so a renamed project or a team they left never
 * shows a stale title.
 */

import apiClient from './client';
import type {
  FavoriteKind,
  FavoriteListRead,
  FavoriteOrder,
  FavoriteRead,
  FavoriteRef,
} from '../types/Api';

/** The route favorites are listed and added on. */
export const favoritesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/favorites`;

/** The route favorites are reordered through. */
export const favoritesOrderPath = (workspaceId: string): string =>
  `${favoritesPath(workspaceId)}/order`;

/** The route one favorite is removed through. */
export const favoritePath = (
  workspaceId: string,
  kind: FavoriteKind,
  targetId: string
): string => `${favoritesPath(workspaceId)}/${kind}/${targetId}`;

/** Reads the caller's favorites, answering an empty list for a missing body. */
export const listFavorites = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<FavoriteRead[]> => {
  const response = await apiClient.get<FavoriteListRead>(
    favoritesPath(workspaceId),
    signal === undefined ? undefined : { signal }
  );
  return Array.isArray(response.data?.favorites) ? response.data.favorites : [];
};

/** Stars one target. Starring one already starred keeps its place. */
export const addFavorite = async (
  workspaceId: string,
  ref: FavoriteRef
): Promise<FavoriteRead> => {
  const response = await apiClient.post<FavoriteRead>(
    favoritesPath(workspaceId),
    ref
  );
  return response.data;
};

/** Unstars one favorite. Unstarring one not starred is not an error. */
export const removeFavorite = async (
  workspaceId: string,
  kind: FavoriteKind,
  targetId: string
): Promise<void> => {
  await apiClient.delete<void>(favoritePath(workspaceId, kind, targetId));
};

/** Puts the caller's favorites in a new order, answering the resolved listing. */
export const reorderFavorites = async (
  workspaceId: string,
  order: FavoriteOrder
): Promise<FavoriteRead[]> => {
  const response = await apiClient.put<FavoriteListRead>(
    favoritesOrderPath(workspaceId),
    order
  );
  return Array.isArray(response.data?.favorites) ? response.data.favorites : [];
};
