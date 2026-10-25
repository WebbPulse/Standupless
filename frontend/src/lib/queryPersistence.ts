/**
 * The copy of the workspace this device keeps between sessions, so a reload
 * paints the last lists, issues and sidebar before the network answers and a
 * lost connection still has something to show.
 *
 * Only the reads named in {@link persistedQueryPrefixes}, less those in
 * {@link persistedQueryExclusions}, are stored, in IndexedDB through the
 * shared polled query persister, under a namespace of the signed in person
 * and the open workspace. Nothing from auth, tokens or settings is ever on
 * that list. Of the issues read, only the {@link PERSISTED_ISSUE_LIMIT} most
 * recently opened are kept, so hover cards and chips do not crowd out the
 * issues a person actually looked at. Opening another workspace deletes every
 * other namespace this browser holds, and signing out deletes them all.
 *
 * The browser's local storage holds one small index beside it: the workspace
 * id each slug last resolved to, so a reload starts the persister before the
 * workspace list has been read.
 */

import { useEffect } from 'react';
import {
  clearAllPersistedPolledQueries,
  clearPersistedPolledQueries,
  createIndexedDbQueryStore,
  listPersistedNamespaces,
  persistPolledQueryCache,
  serializeQueryKey,
  type PolledQueryPersistence,
  type QueryCacheStore,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  WORKSPACES_KEY,
  favoritesKey,
  inboxCountKey,
  inboxCountsKey,
  issueKey,
  memberDirectoryKey,
  membersKey,
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

/** How many reads one namespace keeps, room for the lists, the issues and every team's lookups. */
export const PERSISTED_QUERY_MAX_ENTRIES = 300;

/** How many opened issues one namespace keeps. */
export const PERSISTED_ISSUE_LIMIT = 50;

/** The local storage key the namespace index used to live under, removed on sign out. */
const LEGACY_NAMESPACES_STORAGE_KEY = 'standupless.queryCache.v1.namespaces';

/** Where the workspace id each slug last resolved to is held. */
export const PERSISTED_WORKSPACE_IDS_STORAGE_KEY =
  'standupless.queryCache.v1.workspaceIds';

/** What every namespace this app writes starts with. */
const NAMESPACE_PREFIX = 'standupless:';

/** The namespace one person's copy of one workspace is stored under. */
export const persistedNamespace = (
  userId: string,
  workspaceId: string
): string => `${NAMESPACE_PREFIX}${userId}:${workspaceId}`;

/**
 * The key prefixes stored for one workspace: the workspace list, the team
 * list, every issue list and board with the statuses, labels and people its
 * rows resolve against, the issues opened, the workspace's members, each
 * team's statuses and labels, the inbox, and the sidebar's views, favorites
 * and badges. Statuses and labels are keyed by team alone, which the
 * workspace namespace already scopes.
 */
export const persistedQueryPrefixes = (workspaceId: string): QueryKey[] => [
  WORKSPACES_KEY,
  teamsKey(workspaceId),
  ['issue-collection', workspaceId],
  ['issue-appearance', workspaceId],
  ['issue-context', workspaceId],
  ['issue', workspaceId],
  membersKey(workspaceId),
  ['statuses'],
  ['labels'],
  ['inbox', workspaceId],
  inboxCountKey(workspaceId),
  inboxCountsKey(workspaceId),
  triageSummaryKey(workspaceId),
  viewsKey(workspaceId, 'all', ''),
  reviewsKey(workspaceId),
  pulseCountKey(workspaceId),
  favoritesKey(workspaceId),
];

/**
 * The keys under those prefixes never stored: the admin member directory,
 * which carries invites, suspensions and email addresses.
 */
export const persistedQueryExclusions = (workspaceId: string): QueryKey[] => [
  memberDirectoryKey(workspaceId),
];

/** Whether a stored record holds one issue. */
const isIssueRecord = (key: string): boolean => {
  try {
    const parts: unknown = JSON.parse(key);
    return Array.isArray(parts) && parts[0] === 'issue';
  } catch {
    return false;
  }
};

/** A store that keeps only the most recently opened issues, and the call that opens one. */
interface IssueLimitedStore {
  store: QueryCacheStore;
  workspaceId: string;
  open: (key: string) => void;
}

/**
 * Wraps a store so that, of the issue records in one namespace, only the
 * {@link PERSISTED_ISSUE_LIMIT} most recently opened are written and kept.
 * Records already stored count as opened, newest first, so the list survives
 * a reload. Other namespaces and every other record pass straight through.
 */
const withIssueLimit = (
  base: QueryCacheStore,
  namespace: string,
  workspaceId: string
): IssueLimitedStore => {
  let recent: string[] = [];
  const trim = (): string[] => {
    const dropped = recent.slice(PERSISTED_ISSUE_LIMIT);
    recent = recent.slice(0, PERSISTED_ISSUE_LIMIT);
    return dropped;
  };
  const listNamespaces = base.listNamespaces?.bind(base);
  const clearAll = base.clearAll?.bind(base);
  const store: QueryCacheStore = {
    load: async (ns) => {
      const records = await base.load(ns);
      if (ns !== namespace) return records;
      const stored = records
        .filter((record) => isIssueRecord(record.key))
        .sort((a, b) => b.fetchedAt - a.fetchedAt)
        .map((record) => record.key);
      recent = [...new Set([...recent, ...stored])];
      const dropped = new Set(trim());
      if (dropped.size > 0) await base.remove(ns, [...dropped]);
      return records.filter((record) => !dropped.has(record.key));
    },
    save: (ns, queries) =>
      base.save(
        ns,
        ns !== namespace
          ? queries
          : queries.filter(
              (query) => !isIssueRecord(query.key) || recent.includes(query.key)
            )
      ),
    remove: (ns, keys) => base.remove(ns, keys),
    clear: (ns) => base.clear(ns),
    ...(listNamespaces === undefined ? {} : { listNamespaces }),
    ...(clearAll === undefined ? {} : { clearAll }),
  };
  const open = (key: string): void => {
    recent = [key, ...recent.filter((held) => held !== key)];
    const dropped = trim();
    if (dropped.length > 0) {
      void base.remove(namespace, dropped).catch(() => undefined);
    }
  };
  return { store, workspaceId, open };
};

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

/** The running persister's store, which tracks the issues opened. */
let opened: IssueLimitedStore | null = null;

/**
 * Deletes every namespace of this app except the one kept, skipping any that
 * became the running one in the meantime. Never rejects.
 */
const clearOtherNamespaces = async (
  keep: string,
  store?: QueryCacheStore
): Promise<void> => {
  const held = await listPersistedNamespaces(store);
  await Promise.all(
    held
      .filter(
        (namespace) =>
          namespace !== keep &&
          namespace.startsWith(NAMESPACE_PREFIX) &&
          running?.namespace !== namespace
      )
      .map((namespace) => clearPersistedPolledQueries(namespace, store))
  );
};

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
  const base = store ?? createIndexedDbQueryStore();
  opened =
    base === undefined ? null : withIssueLimit(base, namespace, workspaceId);
  running = persistPolledQueryCache({
    namespace,
    prefixes: persistedQueryPrefixes(workspaceId),
    exclude: persistedQueryExclusions(workspaceId),
    version: PERSISTED_QUERY_VERSION,
    maxEntries: PERSISTED_QUERY_MAX_ENTRIES,
    maxEntryBytes: PERSISTED_QUERY_MAX_ENTRY_CHARS,
    ...(opened === null ? {} : { store: opened.store }),
  });
  void clearOtherNamespaces(namespace, store);
  return running;
};

/**
 * Marks an issue as opened, so its read is kept on this device among the
 * {@link PERSISTED_ISSUE_LIMIT} most recent. The ref is the id or key the
 * view read the issue by. Does nothing for another workspace than the one
 * persisting.
 */
export const recordOpenedIssue = (
  workspaceId: string,
  issueRef: string
): void => {
  if (workspaceId === '' || issueRef === '') return;
  if (opened === null || opened.workspaceId !== workspaceId) return;
  opened.open(serializeQueryKey(issueKey(workspaceId, issueRef)));
};

/**
 * Stops persisting and deletes every namespace this browser holds, for a
 * session that ended. The upstream clear stops writes before anything is
 * deleted, so a read settling during sign out is not written back. Never
 * rejects.
 */
export const clearQueryPersistence = async (
  store?: QueryCacheStore
): Promise<void> => {
  running = null;
  opened = null;
  writeStored(PERSISTED_WORKSPACE_IDS_STORAGE_KEY, null);
  writeStored(LEGACY_NAMESPACES_STORAGE_KEY, null);
  await clearAllPersistedPolledQueries(store);
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
