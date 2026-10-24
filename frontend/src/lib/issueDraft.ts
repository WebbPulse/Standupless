/**
 * The new issue a person was writing when the create dialog closed, kept in
 * this browser per workspace and per viewer so pressing C again brings it
 * back. Storage can be missing, full or hold something another version wrote,
 * so anything unreadable reads as no draft, and a refused write reports
 * failure so the dialog can fall back to asking before it throws text away.
 */

import { useSyncExternalStore } from 'react';
import { stripPending } from './draftUploads';
import type { IssuePriority } from '../types/Api';

/** The prefix every draft's storage key starts with. */
export const ISSUE_DRAFT_STORAGE_PREFIX = 'standupless.issueDraft';

/** The window event fired whenever a draft is written or cleared here. */
const CHANGE_EVENT = 'standupless:issue-draft';

/** The parent a draft is filed under. */
export interface IssueDraftParent {
  id: string;
  key: string;
  title: string;
}

/** Everything a saved draft holds. */
export interface IssueDraft {
  teamId: string;
  title: string;
  body: string;
  templateId: string | null;
  templateTitle: string;
  templateBody: string;
  answers: Record<string, string | boolean>;
  statusId: string;
  priority: IssuePriority;
  assigneeId: string | null;
  labelIds: string[];
  estimate: string | null;
  projectId: string | null;
  projectMilestoneId: string | null;
  cycleId: string | null;
  startDate: string | null;
  dueDate: string | null;
  parent: IssueDraftParent | null;
  subIssues: string[];
}

const PRIORITIES: readonly string[] = [
  'none',
  'urgent',
  'high',
  'medium',
  'low',
];

/** The storage key of one viewer's draft in one workspace, or null without both. */
export const issueDraftStorageKey = (
  workspaceId: string,
  viewerId: string | null | undefined
): string | null =>
  workspaceId === '' ||
  viewerId === null ||
  viewerId === undefined ||
  viewerId === ''
    ? null
    : `${ISSUE_DRAFT_STORAGE_PREFIX}.${workspaceId}.${viewerId}`;

/** Whether a value is a string or null. */
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** Whether a parsed value is a usable parent. */
const isParent = (value: unknown): value is IssueDraftParent | null => {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.key === 'string' &&
    typeof row.title === 'string'
  );
};

/** Whether a parsed value is a set of form answers. */
const isAnswers = (value: unknown): value is Record<string, string | boolean> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (answer) => typeof answer === 'string' || typeof answer === 'boolean'
  );

/** Whether a value is a list of strings. */
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Whether a parsed value has the shape of a saved draft. */
export const isIssueDraft = (value: unknown): value is IssueDraft => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.teamId === 'string' &&
    row.teamId !== '' &&
    typeof row.title === 'string' &&
    typeof row.body === 'string' &&
    isNullableString(row.templateId) &&
    typeof row.templateTitle === 'string' &&
    typeof row.templateBody === 'string' &&
    isAnswers(row.answers) &&
    typeof row.statusId === 'string' &&
    typeof row.priority === 'string' &&
    PRIORITIES.includes(row.priority) &&
    isNullableString(row.assigneeId) &&
    isStrings(row.labelIds) &&
    isNullableString(row.estimate) &&
    isNullableString(row.projectId) &&
    isNullableString(row.projectMilestoneId) &&
    isNullableString(row.cycleId) &&
    isNullableString(row.startDate) &&
    isNullableString(row.dueDate) &&
    isParent(row.parent) &&
    isStrings(row.subIssues)
  );
};

/** Tells this tab's listeners that a draft changed. */
const announce = (): void => {
  try {
    globalThis.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    return;
  }
};

/** The saved draft, or null when there is none or storage is unreadable. */
export const readIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined
): IssueDraft | null => {
  const storageKey = issueDraftStorageKey(workspaceId, viewerId);
  if (storageKey === null) return null;
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isIssueDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Saves a draft, with placeholders for files not yet uploaded taken out of
 * its description since those files cannot outlive the dialog. Answers
 * whether the draft is now stored.
 */
export const writeIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined,
  draft: IssueDraft
): boolean => {
  const storageKey = issueDraftStorageKey(workspaceId, viewerId);
  if (storageKey === null) return false;
  const stored: IssueDraft = {
    ...draft,
    body: draft.body.includes('pending-upload:')
      ? stripPending(draft.body)
      : draft.body,
    subIssues: draft.subIssues.filter((row) => row.trim() !== ''),
  };
  try {
    const next = JSON.stringify(stored);
    const held = globalThis.localStorage.getItem(storageKey);
    if (held === next) return true;
    globalThis.localStorage.setItem(storageKey, next);
  } catch {
    return false;
  }
  announce();
  return true;
};

/** Removes the saved draft, if any. */
export const clearIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined
): void => {
  const storageKey = issueDraftStorageKey(workspaceId, viewerId);
  if (storageKey === null) return;
  try {
    if (globalThis.localStorage.getItem(storageKey) === null) return;
    globalThis.localStorage.removeItem(storageKey);
  } catch {
    return;
  }
  announce();
};

/** Calls back whenever a draft changes in this tab or another one. */
const subscribe = (onChange: () => void): (() => void) => {
  try {
    globalThis.addEventListener(CHANGE_EVENT, onChange);
    globalThis.addEventListener('storage', onChange);
  } catch {
    return () => undefined;
  }
  return () => {
    globalThis.removeEventListener(CHANGE_EVENT, onChange);
    globalThis.removeEventListener('storage', onChange);
  };
};

/** Whether a draft is saved for this viewer in this workspace, kept current. */
export const useHasIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined
): boolean =>
  useSyncExternalStore(
    subscribe,
    () => readIssueDraft(workspaceId, viewerId) !== null,
    () => false
  );
