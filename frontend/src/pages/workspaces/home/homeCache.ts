/**
 * The last home each person read per workspace, held in memory for the life of
 * the tab. Coming back to the home draws it at once from here while the fresh
 * read is in flight, so a warm visit never flashes skeletons. Keyed by the
 * signed in user as well, so a sign out and in as someone else starts cold.
 */

import type { HomeRead } from '../../../types/Api';

const cache = new Map<string, HomeRead>();

const keyFor = (userId: string, workspaceId: string): string =>
  `${userId}:${workspaceId}`;

/** The home last read for this person in this workspace, or null. */
export const cachedHome = (
  userId: string,
  workspaceId: string
): HomeRead | null => cache.get(keyFor(userId, workspaceId)) ?? null;

/** Remembers a fresh read. */
export const rememberHome = (
  userId: string,
  workspaceId: string,
  home: HomeRead
): void => {
  cache.set(keyFor(userId, workspaceId), home);
};

/** Forgets every remembered read, for tests. */
export const clearHomeCache = (): void => {
  cache.clear();
};
