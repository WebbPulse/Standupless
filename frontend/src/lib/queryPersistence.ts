/**
 * The copy of the issue lists and the sidebar this device keeps between
 * sessions, so a reload paints the last lists before the network answers and
 * a lost connection still has something to show.
 *
 * Only the reads named in {@link persistedQueryPrefixes} are stored, in
 * IndexedDB through the shared polled query persister, under a namespace of
 * the signed in person and the open workspace. Nothing from auth, tokens or
 * settings is ever on that list. Opening another workspace deletes every other
 * namespace this browser holds, and signing out deletes them all.
 *
 * The browser's local storage holds two small indexes beside it: the
 * namespaces written, so a sign out can find each one, and the workspace id
 * each slug last resolved to, so a reload starts the persister before the
 * workspace list has been read.
 */

import { useEffect } from 'react';
import {
  clearPersistedPolledQueries,
  persistPolledQueryCache,
  type PolledQueryPersistence,
  type QueryCacheStore,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  WORKSPACES_KEY,
  favoritesKey,
  inboxCountKey,
  inboxCountsKey,
  pulseCountKey,
  reviewsKey,
  teamsKey,
  triageSummaryKey,
  viewsKey,
} from './queryKeys';

/** The shape version of what is stored. Bump it when a persisted read changes shape. */
export const PERSISTED_QUERY_VERSION = 1;

/** The largest read stored, in characters of its JSON, which fits a full 500 row list. */
export const PERSISTED_QUERY_MAX_ENTRY_CHARS = 4_000_000;

/** Where the namespaces this browser has written are listed. */
export const PERSISTED_NAMESPACES_STORAGE_KEY =
  'standupless.queryCache.v1.namespaces';

/** Where the workspace id each slug last resolved to is held. */
export const PERSISTED_WORKSPACE_IDS_STORAGE_KEY =
  'standupless.queryCache.v1.workspaceIds';

/** The namespace one person's copy of one workspace is stored under. */
export const persistedNamespace = (
  userId: string,
  workspaceId: string
): string => `standupless:${userId}:${workspaceId}`;

/**
 * The key prefixes stored for one workspace: the workspace list, the team
 * list, every issue list and board with the statuses, labels and people its
 * rows resolve against, the inbox, and the sidebar's views, favorites and
 * badges.
 */
export const persistedQueryPrefixes = (workspaceId: string): QueryKey[] => [
  WORKSPACES_KEY,
  teamsKey(workspaceId),
  ['issue-collection', workspaceId],
  ['issue-appearance', workspaceId],
  ['issue-context', workspaceId],
  ['inbox', workspaceId],
  inboxCountKey(workspaceId),
  inboxCountsKey(workspaceId),
  triageSummaryKey(workspaceId),
  viewsKey(workspaceId, 'all', ''),
  reviewsKey(workspaceId),
  pulseCountKey(workspaceId),
  favoritesKey(workspaceId),
];

/** Reads a JSON value from local storage, or the fallback when absent or unreadable. */
const readStored = <T>(
  key: string,
  fallback: T,
  valid: (v: unknown) => boolean
): T => {
  try {
    const raw = globalThis.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Writes a JSON value to local storage, or removes the key for null. */
const writeStored = (key: string, value: unknown): void => {
  try {
    if (value === null) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
};

/** The namespaces this browser has written and not yet deleted. */
export const readPersistedNamespaces = (): string[] =>
  readStored<string[]>(
    PERSISTED_NAMESPACES_STORAGE_KEY,
    [],
    (value) =>
      Array.isArray(value) && value.every((item) => typeof item === 'string')
  );

/** The workspace ids slugs last resolved to. */
const readWorkspaceIds = (): Record<string, string> =>
  readStored<Record<string, string>>(
    PERSISTED_WORKSPACE_IDS_STORAGE_KEY,
    {},
    (value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
  );

/** The workspace id a slug last resolved to here, or null. */
export const rememberedWorkspaceId = (slug: string): string | null => {
  const id = readWorkspaceIds()[slug];
  return typeof id === 'string' && id !== '' ? id : null;
};

/** Records the workspace id a slug resolved to. */
export const rememberWorkspaceId = (
  slug: string,
  workspaceId: string
): void => {
  if (slug === '' || workspaceId === '') return;
  const held = readWorkspaceIds();
  if (held[slug] === workspaceId) return;
  writeStored(PERSISTED_WORKSPACE_IDS_STORAGE_KEY, {
    ...held,
    [slug]: workspaceId,
  });
};

/** The persister this tab is running, with the namespace it writes. */
let running: PolledQueryPersistence | null = null;

/**
 * Starts persisting one person's reads of one workspace, and deletes every
 * other namespace this browser holds, so a workspace switch leaves only the
 * open workspace on the device. Calling it again for the namespace already
 * running does nothing.
 */
export const startQueryPersistence = (
  userId: string,
  workspaceId: string,
  store?: QueryCacheStore
): PolledQueryPersistence | null => {
  if (userId === '' || workspaceId === '') return null;
  const namespace = persistedNamespace(userId, workspaceId);
  if (running?.namespace === namespace) return running;
  running = persistPolledQueryCache({
    namespace,
    prefixes: persistedQueryPrefixes(workspaceId),
    version: PERSISTED_QUERY_VERSION,
    maxEntryBytes: PERSISTED_QUERY_MAX_ENTRY_CHARS,
    ...(store === undefined ? {} : { store }),
  });
  const others = readPersistedNamespaces().filter((held) => held !== namespace);
  writeStored(PERSISTED_NAMESPACES_STORAGE_KEY, [namespace]);
  for (const held of others) void clearPersistedPolledQueries(held, store);
  return running;
};

/**
 * Stops persisting and deletes every namespace this browser holds, for a
 * session that ended. Writes stop before anything is deleted, so a read
 * settling during sign out is not written back. Never rejects.
 */
export const clearQueryPersistence = async (
  store?: QueryCacheStore
): Promise<void> => {
  const held = running;
  running = null;
  const namespaces = new Set(readPersistedNamespaces());
  if (held !== null) namespaces.add(held.namespace);
  writeStored(PERSISTED_NAMESPACES_STORAGE_KEY, null);
  writeStored(PERSISTED_WORKSPACE_IDS_STORAGE_KEY, null);
  const pending: Promise<void>[] = [];
  if (held !== null) {
    pending.push(held.clear());
    namespaces.delete(held.namespace);
  }
  for (const namespace of namespaces) {
    pending.push(clearPersistedPolledQueries(namespace, store));
  }
  await Promise.all(pending);
};

/**
 * Keeps the persister on the signed in person and the open workspace. Until
 * the workspace list has been read, the slug's last known id stands in, so a
 * reload paints from the device copy instead of waiting on that read.
 */
export const useQueryPersistence = (
  userId: string | undefined,
  slug: string | undefined,
  workspaceId: string
): void => {
  const routeSlug = slug ?? '';
  const resolved =
    workspaceId !== ''
      ? workspaceId
      : ((routeSlug === '' ? null : rememberedWorkspaceId(routeSlug)) ?? '');

  useEffect(() => {
    rememberWorkspaceId(routeSlug, workspaceId);
  }, [routeSlug, workspaceId]);

  useEffect(() => {
    if (userId === undefined || userId === '' || resolved === '') return;
    startQueryPersistence(userId, resolved);
  }, [userId, resolved]);
};
