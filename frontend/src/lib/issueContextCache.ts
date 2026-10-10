/**
 * The last known lists an issue view resolves ids against, kept in this
 * browser per workspace and team, so a reload paints rows with their real
 * statuses and labels at once and the polled reads refresh them in place.
 *
 * Local storage rather than IndexedDB, because the first render reads it
 * synchronously; an asynchronous read would paint once without it and flip.
 * Every read and write tolerates storage being unavailable or full, and the
 * whole cache is dropped on sign-out.
 */

/** The prefix every cached entry is stored under. */
export const ISSUE_CONTEXT_STORAGE_PREFIX = 'standupless.issueContext.v1.';

/** The two cached parts of a team's lists. */
export type IssueContextPart = 'statuses' | 'lists';

/** The storage key of one part of one team's lists. */
const storageKey = (
  workspaceId: string,
  teamId: string,
  part: IssueContextPart
): string => `${ISSUE_CONTEXT_STORAGE_PREFIX}${workspaceId}.${teamId}.${part}`;

/** The cached part for a team, or null when none is held or it is unreadable. */
export const readCachedPart = <T>(
  workspaceId: string,
  teamId: string,
  part: IssueContextPart
): T | null => {
  try {
    const raw = globalThis.localStorage.getItem(
      storageKey(workspaceId, teamId, part)
    );
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
};

/**
 * The cached part for every team, in order, or null unless each team has one,
 * so a view never paints some teams' rows from the cache and others blank.
 */
export const readCachedParts = <T>(
  workspaceId: string,
  teamIds: readonly string[],
  part: IssueContextPart
): T[] | null => {
  if (workspaceId === '' || teamIds.length === 0) return null;
  const held: T[] = [];
  for (const teamId of teamIds) {
    const entry = readCachedPart<T>(workspaceId, teamId, part);
    if (entry === null) return null;
    held.push(entry);
  }
  return held;
};

/** Remembers one part of a team's lists. */
export const writeCachedPart = (
  workspaceId: string,
  teamId: string,
  part: IssueContextPart,
  value: unknown
): void => {
  try {
    globalThis.localStorage.setItem(
      storageKey(workspaceId, teamId, part),
      JSON.stringify(value)
    );
  } catch {
    return;
  }
};

/** Forgets every cached list, for sign-out. */
export const clearIssueContextCache = (): void => {
  try {
    const storage = globalThis.localStorage;
    const doomed: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(ISSUE_CONTEXT_STORAGE_PREFIX) === true) {
        doomed.push(key);
      }
    }
    for (const key of doomed) storage.removeItem(key);
  } catch {
    return;
  }
};
