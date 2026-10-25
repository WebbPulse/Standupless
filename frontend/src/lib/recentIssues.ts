/**
 * The issues a person opened most recently, kept in this browser per
 * workspace and per viewer, so the command palette can offer them before
 * anything is typed. Storage can be missing, full or hold something another
 * version wrote, so anything unreadable reads as an empty list and a refused
 * write is ignored.
 */

import { useEffect } from 'react';
import { hasStatus, NOT_FOUND } from './errors';
import { recordOpenedIssue } from './queryPersistence';

/** One remembered issue, enough to draw its row and open it. */
export interface RecentIssue {
  id: string;
  key: string;
  title: string;
  team_id: string;
  status_id: string;
  in_triage?: boolean;
}

/** The issue fields a view hands over to remember it. */
export type RecentIssueSource = Pick<
  RecentIssue,
  'id' | 'key' | 'title' | 'team_id' | 'status_id'
> & { in_triage?: boolean | null };

/** How many issues the list holds. */
export const RECENT_ISSUE_LIMIT = 8;

/** The prefix every recent list's storage key starts with. */
export const RECENT_ISSUES_STORAGE_PREFIX = 'standupless.recentIssues';

/** The status the API answers when the caller may not read an issue. */
const FORBIDDEN = 403;

/** The storage key of one viewer's list in one workspace, or null without both. */
export const recentIssuesStorageKey = (
  workspaceId: string,
  viewerId: string | null | undefined
): string | null =>
  workspaceId === '' ||
  viewerId === null ||
  viewerId === undefined ||
  viewerId === ''
    ? null
    : `${RECENT_ISSUES_STORAGE_PREFIX}.${workspaceId}.${viewerId}`;

/** Whether a parsed value has the shape of a remembered issue. */
const isRecentIssue = (value: unknown): value is RecentIssue => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Record<keyof RecentIssue, unknown>>;
  return (
    typeof row.id === 'string' &&
    typeof row.key === 'string' &&
    typeof row.title === 'string' &&
    typeof row.team_id === 'string' &&
    typeof row.status_id === 'string' &&
    (row.in_triage === undefined || typeof row.in_triage === 'boolean')
  );
};

/** The remembered issues, newest first, or none when storage is unreadable. */
export const readRecentIssues = (
  workspaceId: string,
  viewerId: string | null | undefined
): RecentIssue[] => {
  const storageKey = recentIssuesStorageKey(workspaceId, viewerId);
  if (storageKey === null) return [];
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentIssue).slice(0, RECENT_ISSUE_LIMIT);
  } catch {
    return [];
  }
};

/** Writes the list, dropping the entry once it is empty. */
const writeRecentIssues = (storageKey: string, rows: RecentIssue[]): void => {
  try {
    if (rows.length === 0) globalThis.localStorage.removeItem(storageKey);
    else globalThis.localStorage.setItem(storageKey, JSON.stringify(rows));
  } catch {
    return;
  }
};

/** Puts an issue at the front of the list, once, keeping at most the limit. */
export const recordRecentIssue = (
  workspaceId: string,
  viewerId: string | null | undefined,
  issue: RecentIssueSource
): void => {
  const storageKey = recentIssuesStorageKey(workspaceId, viewerId);
  if (storageKey === null || issue.id === '') return;
  const entry: RecentIssue = {
    id: issue.id,
    key: issue.key,
    title: issue.title,
    team_id: issue.team_id,
    status_id: issue.status_id,
    ...(issue.in_triage === true ? { in_triage: true } : {}),
  };
  const rest = readRecentIssues(workspaceId, viewerId).filter(
    (row) => row.id !== issue.id
  );
  writeRecentIssues(storageKey, [entry, ...rest].slice(0, RECENT_ISSUE_LIMIT));
};

/** Drops an issue, named by its id or its key, from the list. */
export const forgetRecentIssue = (
  workspaceId: string,
  viewerId: string | null | undefined,
  issueRef: string
): void => {
  const storageKey = recentIssuesStorageKey(workspaceId, viewerId);
  if (storageKey === null || issueRef === '') return;
  const wanted = issueRef.toUpperCase();
  const held = readRecentIssues(workspaceId, viewerId);
  const kept = held.filter(
    (row) => row.id !== issueRef && row.key.toUpperCase() !== wanted
  );
  if (kept.length !== held.length) writeRecentIssues(storageKey, kept);
};

/** Whether a failed read means the issue is gone or no longer readable. */
export const isUnreadableIssue = (error: unknown): boolean =>
  hasStatus(error, NOT_FOUND) || hasStatus(error, FORBIDDEN);

/**
 * Remembers the issue a view shows once it loads, and forgets the one it
 * names when reading it fails because it is gone or no longer readable. A
 * loaded issue is also marked opened, so this device keeps its read for
 * offline use.
 */
export const useRecordRecentIssue = (
  workspaceId: string,
  viewerId: string | null | undefined,
  issueRef: string,
  issue: RecentIssueSource | null | undefined,
  error: unknown
): void => {
  const id = issue?.id ?? '';
  const key = issue?.key ?? '';
  const title = issue?.title ?? '';
  const teamId = issue?.team_id ?? '';
  const statusId = issue?.status_id ?? '';
  const inTriage = issue?.in_triage === true;
  const unreadable = isUnreadableIssue(error);

  useEffect(() => {
    if (id === '') return;
    recordOpenedIssue(workspaceId, issueRef);
    recordRecentIssue(workspaceId, viewerId, {
      id,
      key,
      title,
      team_id: teamId,
      status_id: statusId,
      in_triage: inTriage,
    });
  }, [
    workspaceId,
    viewerId,
    issueRef,
    id,
    key,
    title,
    teamId,
    statusId,
    inTriage,
  ]);

  useEffect(() => {
    if (unreadable) forgetRecentIssue(workspaceId, viewerId, issueRef);
  }, [workspaceId, viewerId, issueRef, unreadable]);
};
