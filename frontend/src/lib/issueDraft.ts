/**
 * The new issues a person has started in the create dialog and not filed yet,
 * kept on the server per workspace and per viewer so they follow the person
 * across devices, many at a time.
 *
 * Every change lands first in a small outbox in this browser and is then sent,
 * so a failed request or a closed tab never loses typed text: the outbox is
 * sent again on the next load. A discard is held in the outbox the same way,
 * as a tombstone, until the server has removed the draft. Storage can be
 * missing, full or hold something another version wrote, so anything
 * unreadable reads as nothing held, and a refused write reports failure so
 * the dialog can fall back to asking before it throws text away.
 *
 * The single draft an earlier version kept in this browser is moved into the
 * outbox once, and sent from there like any other.
 */

import { useMemo, useSyncExternalStore } from 'react';
import {
  deleteNewIssueDraft,
  listNewIssueDrafts,
  saveNewIssueDraft,
} from '../api/newIssueDrafts';
import { hasPending, stripPending } from './draftUploads';
import { CONFLICT, hasStatus } from './errors';
import type {
  IssueDraftRead,
  IssueDraftWrite,
  IssuePriority,
} from '../types/Api';

/** The prefix of the single draft an earlier version kept in this browser. */
export const ISSUE_DRAFT_STORAGE_PREFIX = 'standupless.issueDraft';

/** The prefix of the outbox of drafts not yet confirmed by the server. */
export const ISSUE_DRAFT_OUTBOX_PREFIX = 'standupless.issueDrafts';

/** What a person reads once they hold as many drafts as they may keep. */
export const ISSUE_DRAFT_LIMIT_MESSAGE =
  'You have reached the most drafts you can keep. Delete a draft to save another.';

/** The window event fired whenever a draft changes here. */
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

/** One draft in the Drafts list, with its id and when it was last saved. */
export interface SavedIssueDraft {
  id: string;
  draft: IssueDraft;
  updatedAt: string;
}

/** How sending one draft to the server ended. */
export type IssueDraftUpload = 'saved' | 'limit' | 'failed';

/** One outbox entry: the draft to save, or null for a discard still to send. */
interface OutboxEntry {
  draft: IssueDraft | null;
  updatedAt: string;
}

type Outbox = Record<string, OutboxEntry>;

const PRIORITIES: readonly string[] = [
  'none',
  'urgent',
  'high',
  'medium',
  'low',
];

/** Whether a viewer and workspace are both known. */
const known = (
  workspaceId: string,
  viewerId: string | null | undefined
): viewerId is string =>
  workspaceId !== '' &&
  viewerId !== null &&
  viewerId !== undefined &&
  viewerId !== '';

/** The storage key of the earlier single draft, or null without both ids. */
export const issueDraftStorageKey = (
  workspaceId: string,
  viewerId: string | null | undefined
): string | null =>
  known(workspaceId, viewerId)
    ? `${ISSUE_DRAFT_STORAGE_PREFIX}.${workspaceId}.${viewerId}`
    : null;

/** The storage key of one viewer's outbox in one workspace, or null without both. */
export const issueDraftOutboxKey = (
  workspaceId: string,
  viewerId: string | null | undefined
): string | null =>
  known(workspaceId, viewerId)
    ? `${ISSUE_DRAFT_OUTBOX_PREFIX}.${workspaceId}.${viewerId}`
    : null;

/** A fresh draft id, unique enough to be named before the first save. */
export const newIssueDraftId = (): string => {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
};

/** Whether a value is a string or null. */
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/** Whether a parsed value is a usable parent. */
const isParent = (value: unknown): value is IssueDraftParent | null => {
  if (value === null) return true;
  if (typeof value !== 'object') return false;
  const row = value as Partial<Record<keyof IssueDraftParent, unknown>>;
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
  const row = value as Partial<Record<keyof IssueDraft, unknown>>;
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

/** Whether a draft holds anything typed, the same test the server holds a save to. */
export const issueDraftHasContent = (draft: IssueDraft): boolean =>
  draft.title.trim() !== '' ||
  draft.body.trim() !== '' ||
  draft.subIssues.some((row) => row.trim() !== '') ||
  Object.values(draft.answers).some(
    (answer) =>
      answer === true || (typeof answer === 'string' && answer.trim() !== '')
  );

/**
 * A draft as it is kept: placeholders for files not yet uploaded are taken out
 * of the description, since those files cannot outlive the dialog, and blank
 * sub-issue rows are dropped.
 */
const keptDraft = (draft: IssueDraft): IssueDraft => ({
  ...draft,
  body: hasPending(draft.body) ? stripPending(draft.body) : draft.body,
  subIssues: draft.subIssues.filter((row) => row.trim() !== ''),
});

/** The body the save route takes for a draft. */
export const issueDraftWrite = (draft: IssueDraft): IssueDraftWrite => ({
  team_id: draft.teamId,
  title: draft.title,
  body: draft.body,
  template_id: draft.templateId,
  template_title: draft.templateTitle,
  template_body: draft.templateBody,
  answers: draft.answers,
  status_id: draft.statusId === '' ? null : draft.statusId,
  priority: draft.priority,
  assignee_id: draft.assigneeId,
  label_ids: draft.labelIds,
  estimate: draft.estimate,
  project_id: draft.projectId,
  project_milestone_id: draft.projectMilestoneId,
  cycle_id: draft.cycleId,
  start_date: draft.startDate,
  due_date: draft.dueDate,
  parent_id: draft.parent?.id ?? null,
  parent_key: draft.parent?.key ?? null,
  parent_title: draft.parent?.title ?? null,
  sub_issues: draft.subIssues,
});

/** A draft the server sent back, as the dialog holds it. */
export const issueDraftOfRead = (row: IssueDraftRead): SavedIssueDraft => ({
  id: row.draft_id,
  updatedAt: row.updated_at,
  draft: {
    teamId: row.team_id,
    title: row.title,
    body: row.body,
    templateId: row.template_id ?? null,
    templateTitle: row.template_title ?? '',
    templateBody: row.template_body ?? '',
    answers: row.answers ?? {},
    statusId: row.status_id ?? '',
    priority: PRIORITIES.includes(row.priority ?? '')
      ? (row.priority as IssuePriority)
      : 'none',
    assigneeId: row.assignee_id ?? null,
    labelIds: row.label_ids ?? [],
    estimate: row.estimate ?? null,
    projectId: row.project_id ?? null,
    projectMilestoneId: row.project_milestone_id ?? null,
    cycleId: row.cycle_id ?? null,
    startDate: row.start_date ?? null,
    dueDate: row.due_date ?? null,
    parent:
      row.parent_id === null || row.parent_id === undefined
        ? null
        : {
            id: row.parent_id,
            key: row.parent_key ?? '',
            title: row.parent_title ?? '',
          },
    subIssues: row.sub_issues ?? [],
  },
});

/** The drafts the server last listed, per outbox key. */
const serverDrafts = new Map<string, SavedIssueDraft[]>();

/** The send in flight per draft, so saves of one draft never overtake each other. */
const sends = new Map<string, Promise<IssueDraftUpload>>();

/** Tells this tab's listeners that a draft changed. */
const announce = (): void => {
  try {
    globalThis.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    return;
  }
};

/** Whether a parsed value is an outbox entry. */
const isEntry = (value: unknown): value is OutboxEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Record<keyof OutboxEntry, unknown>>;
  return (
    typeof row.updatedAt === 'string' &&
    (row.draft === null || isIssueDraft(row.draft))
  );
};

/** The outbox under one key, reading anything unreadable as empty. */
const readOutbox = (storageKey: string): Outbox => {
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const outbox: Outbox = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (isEntry(entry)) outbox[id] = entry;
    }
    return outbox;
  } catch {
    return {};
  }
};

/** Writes the outbox under one key, answering whether it is stored. */
const writeOutbox = (storageKey: string, outbox: Outbox): boolean => {
  try {
    if (Object.keys(outbox).length === 0) {
      globalThis.localStorage.removeItem(storageKey);
    } else {
      globalThis.localStorage.setItem(storageKey, JSON.stringify(outbox));
    }
    return true;
  } catch {
    return false;
  }
};

/** The drafts the server holds and the outbox has not changed, merged with the outbox, newest first. */
const mergedDrafts = (storageKey: string): SavedIssueDraft[] => {
  const byId = new Map<string, SavedIssueDraft>();
  for (const row of serverDrafts.get(storageKey) ?? []) byId.set(row.id, row);
  for (const [id, entry] of Object.entries(readOutbox(storageKey))) {
    if (entry.draft === null) byId.delete(id);
    else byId.set(id, { id, draft: entry.draft, updatedAt: entry.updatedAt });
  }
  return [...byId.values()].sort((left, right) => {
    const byTime = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (Number.isFinite(byTime) && byTime !== 0) return byTime;
    return right.id < left.id ? -1 : right.id > left.id ? 1 : 0;
  });
};

/** The viewer's drafts in one workspace, newest first, as this tab knows them. */
export const readIssueDrafts = (
  workspaceId: string,
  viewerId: string | null | undefined
): SavedIssueDraft[] => {
  const storageKey = issueDraftOutboxKey(workspaceId, viewerId);
  return storageKey === null ? [] : mergedDrafts(storageKey);
};

/**
 * Holds a draft in the outbox to be sent, or a discard when it holds nothing
 * typed. Answers whether the change is stored, so the dialog can ask before
 * it closes over text it could not keep.
 */
export const stashIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined,
  draftId: string,
  draft: IssueDraft
): boolean => {
  const storageKey = issueDraftOutboxKey(workspaceId, viewerId);
  if (storageKey === null) return false;
  const kept = keptDraft(draft);
  const typed = issueDraftHasContent(kept);
  const outbox = readOutbox(storageKey);
  const held = outbox[draftId];
  const current =
    held === undefined
      ? serverDrafts.get(storageKey)?.find((row) => row.id === draftId)?.draft
      : held.draft;
  const next = typed ? kept : null;
  if (JSON.stringify(current ?? null) === JSON.stringify(next)) {
    return true;
  }
  outbox[draftId] = { draft: next, updatedAt: new Date().toISOString() };
  if (!writeOutbox(storageKey, outbox)) return false;
  announce();
  return true;
};

/**
 * Sends one draft's held change to the server and, once it is confirmed and
 * unchanged since, drops it from the outbox. Answers "limit" when the person
 * already keeps as many drafts as they may, leaving the draft held here.
 */
export const uploadIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined,
  draftId: string
): Promise<IssueDraftUpload> => {
  const storageKey = issueDraftOutboxKey(workspaceId, viewerId);
  if (storageKey === null) return Promise.resolve('failed');
  const sendKey = `${storageKey}.${draftId}`;
  const send = async (): Promise<IssueDraftUpload> => {
    const entry = readOutbox(storageKey)[draftId];
    if (entry === undefined) return 'saved';
    const listed = serverDrafts.get(storageKey) ?? [];
    try {
      if (entry.draft === null) {
        await deleteNewIssueDraft(workspaceId, draftId);
        serverDrafts.set(
          storageKey,
          listed.filter((row) => row.id !== draftId)
        );
      } else {
        const saved: IssueDraftRead | undefined = await saveNewIssueDraft(
          workspaceId,
          draftId,
          issueDraftWrite(entry.draft)
        );
        const row: SavedIssueDraft =
          saved?.draft_id === undefined
            ? { id: draftId, draft: entry.draft, updatedAt: entry.updatedAt }
            : issueDraftOfRead(saved);
        serverDrafts.set(storageKey, [
          row,
          ...listed.filter((held) => held.id !== draftId),
        ]);
      }
    } catch (error) {
      return hasStatus(error, CONFLICT) ? 'limit' : 'failed';
    }
    const outbox = readOutbox(storageKey);
    if (JSON.stringify(outbox[draftId]) === JSON.stringify(entry)) {
      writeOutbox(
        storageKey,
        Object.fromEntries(
          Object.entries(outbox).filter(([id]) => id !== draftId)
        )
      );
    }
    announce();
    return 'saved';
  };
  const next = (
    sends.get(sendKey) ?? Promise.resolve<IssueDraftUpload>('saved')
  )
    .catch(() => 'failed' as const)
    .then(send);
  sends.set(sendKey, next);
  void next.finally(() => {
    if (sends.get(sendKey) === next) sends.delete(sendKey);
  });
  return next;
};

/** Discards one draft here at once and on the server as soon as it answers. */
export const discardIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined,
  draftId: string
): void => {
  const storageKey = issueDraftOutboxKey(workspaceId, viewerId);
  if (storageKey === null) return;
  const outbox = readOutbox(storageKey);
  const listed = serverDrafts.get(storageKey) ?? [];
  const onServer = listed.some((row) => row.id === draftId);
  if (outbox[draftId] === undefined && !onServer) return;
  outbox[draftId] = { draft: null, updatedAt: new Date().toISOString() };
  writeOutbox(storageKey, outbox);
  serverDrafts.set(
    storageKey,
    listed.filter((row) => row.id !== draftId)
  );
  announce();
  void uploadIssueDraft(workspaceId, viewerId, draftId);
};

/** Sends every change the outbox holds, such as those a closed tab left behind. */
export const flushIssueDrafts = async (
  workspaceId: string,
  viewerId: string | null | undefined
): Promise<void> => {
  const storageKey = issueDraftOutboxKey(workspaceId, viewerId);
  if (storageKey === null) return;
  await Promise.all(
    Object.keys(readOutbox(storageKey)).map((draftId) =>
      uploadIssueDraft(workspaceId, viewerId, draftId)
    )
  );
};

/** Reads the viewer's drafts from the server, keeping what was known on a failure. */
export const refreshIssueDrafts = async (
  workspaceId: string,
  viewerId: string | null | undefined
): Promise<void> => {
  const storageKey = issueDraftOutboxKey(workspaceId, viewerId);
  if (storageKey === null) return;
  try {
    const rows = await listNewIssueDrafts(workspaceId);
    serverDrafts.set(storageKey, rows.map(issueDraftOfRead));
  } catch {
    return;
  }
  announce();
};

/**
 * Moves the single draft an earlier version kept in this browser into the
 * outbox under a new id, then removes it, so it is sent once like any other.
 */
export const migrateLegacyIssueDraft = (
  workspaceId: string,
  viewerId: string | null | undefined
): void => {
  const legacyKey = issueDraftStorageKey(workspaceId, viewerId);
  if (legacyKey === null) return;
  try {
    const raw = globalThis.localStorage.getItem(legacyKey);
    if (raw === null) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (
      isIssueDraft(parsed) &&
      !stashIssueDraft(workspaceId, viewerId, newIssueDraftId(), parsed)
    ) {
      return;
    }
    globalThis.localStorage.removeItem(legacyKey);
  } catch {
    return;
  }
};

/** Forgets every draft the server listed, for tests and sign out. */
export const resetIssueDraftCache = (): void => {
  serverDrafts.clear();
  sends.clear();
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

/** The viewer's drafts in one workspace, newest first, kept current. */
export const useIssueDrafts = (
  workspaceId: string,
  viewerId: string | null | undefined
): SavedIssueDraft[] => {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(readIssueDrafts(workspaceId, viewerId)),
    () => '[]'
  );
  return useMemo(() => JSON.parse(snapshot) as SavedIssueDraft[], [snapshot]);
};
