/**
 * The searches a person ran most recently on the Search page, kept in this
 * browser per workspace so a repeat search is two keystrokes. Storage can be
 * missing, full or hold something another version wrote, so anything
 * unreadable reads as an empty list and a refused write is ignored.
 */

/** One remembered search: the term and the filters it ran under. */
export interface RecentSearch {
  q: string;
  team: string;
  type: string;
  status: string;
}

/** How many searches the list holds. */
export const RECENT_SEARCH_LIMIT = 10;

/** The prefix every recent search list's storage key starts with. */
export const RECENT_SEARCHES_STORAGE_PREFIX = 'standupless.recentSearches';

/** The storage key of one workspace's list, or null without a workspace. */
export const recentSearchesStorageKey = (workspaceId: string): string | null =>
  workspaceId === ''
    ? null
    : `${RECENT_SEARCHES_STORAGE_PREFIX}.${workspaceId}`;

/** Whether a parsed value has the shape of a remembered search. */
const isRecentSearch = (value: unknown): value is RecentSearch => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Record<keyof RecentSearch, unknown>>;
  return (
    typeof row.q === 'string' &&
    row.q.trim() !== '' &&
    typeof row.team === 'string' &&
    typeof row.type === 'string' &&
    typeof row.status === 'string'
  );
};

/** The identity two searches share when they would run the same query. */
export const recentSearchIdentity = (entry: RecentSearch): string =>
  JSON.stringify([
    entry.q.trim().toLowerCase(),
    entry.team,
    entry.type,
    entry.status,
  ]);

/** The remembered searches, newest first, or none when storage is unreadable. */
export const readRecentSearches = (workspaceId: string): RecentSearch[] => {
  const storageKey = recentSearchesStorageKey(workspaceId);
  if (storageKey === null) return [];
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentSearch).slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
};

/** Writes the list, dropping the entry once it is empty. */
const writeRecentSearches = (
  storageKey: string,
  rows: RecentSearch[]
): void => {
  try {
    if (rows.length === 0) globalThis.localStorage.removeItem(storageKey);
    else globalThis.localStorage.setItem(storageKey, JSON.stringify(rows));
  } catch {
    return;
  }
};

/**
 * Puts a search at the front of the list, once, keeping at most the limit,
 * and answers the list as it now stands so the page can redraw without a
 * second read. A blank term is not remembered.
 */
export const recordRecentSearch = (
  workspaceId: string,
  search: RecentSearch
): RecentSearch[] => {
  const storageKey = recentSearchesStorageKey(workspaceId);
  const q = search.q.trim();
  if (storageKey === null || q === '') return readRecentSearches(workspaceId);
  const entry: RecentSearch = {
    q,
    team: search.team,
    type: search.type,
    status: search.status,
  };
  const identity = recentSearchIdentity(entry);
  const rest = readRecentSearches(workspaceId).filter(
    (row) => recentSearchIdentity(row) !== identity
  );
  const next = [entry, ...rest].slice(0, RECENT_SEARCH_LIMIT);
  writeRecentSearches(storageKey, next);
  return next;
};

/** Drops one search from the list and answers the list as it now stands. */
export const forgetRecentSearch = (
  workspaceId: string,
  search: RecentSearch
): RecentSearch[] => {
  const storageKey = recentSearchesStorageKey(workspaceId);
  const held = readRecentSearches(workspaceId);
  if (storageKey === null) return held;
  const identity = recentSearchIdentity(search);
  const kept = held.filter((row) => recentSearchIdentity(row) !== identity);
  if (kept.length !== held.length) writeRecentSearches(storageKey, kept);
  return kept;
};

/** Empties one workspace's list. */
export const clearRecentSearches = (workspaceId: string): void => {
  const storageKey = recentSearchesStorageKey(workspaceId);
  if (storageKey !== null) writeRecentSearches(storageKey, []);
};
