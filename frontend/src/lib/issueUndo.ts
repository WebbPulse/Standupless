/**
 * What undoing an issue change writes. A change is captured as the issue
 * before it and after it, and the revert is the difference: each property
 * that moved goes back to its old value through the single issue route or,
 * for many issues sharing one revert, the bulk route, so every undo is an
 * ordinary edit that activity records. Titles and descriptions are left to
 * their editors' own undo.
 */

import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import {
  BULK_MAX_ISSUES,
  bulkUpdateIssues,
  moveIssue,
  updateIssue,
  type IssueBulkPatch,
} from '../api/issues';
import type { IssueRead, IssueUpdate } from '../types/Api';
import { activityKey, issueKey } from './queryKeys';
import { TRIAGE_STATUS_ID } from './triageStatus';
import { pushUndo } from './undo';

/** The plain fields an undo puts back, each compared and restored as is. */
const PLAIN_FIELDS = [
  'priority',
  'assignee_id',
  'estimate',
  'start_date',
  'due_date',
  'parent_id',
  'cycle_id',
  'project_id',
  'project_milestone_id',
] as const;

/** A plain field an undo puts back. */
type PlainField = (typeof PLAIN_FIELDS)[number];

/** The fields the bulk route cannot write, so a revert naming one goes issue by issue. */
const SINGLE_ONLY: ReadonlySet<string> = new Set([
  'start_date',
  'due_date',
  'parent_id',
]);

/** The words a changed field reads as in a change's notice. */
const FIELD_NAMES: Record<string, string> = {
  status_id: 'status',
  priority: 'priority',
  assignee_id: 'assignee',
  label_ids: 'labels',
  estimate: 'estimate',
  start_date: 'start date',
  due_date: 'due date',
  parent_id: 'parent',
  cycle_id: 'cycle',
  project_id: 'project',
  project_milestone_id: 'milestone',
};

/** One issue's way back to how it was before a change. */
export interface IssueRevert {
  issueId: string;
  /** The single issue patch that writes the old values back. */
  patch: IssueUpdate;
  /** The same revert as a bulk patch, or null when the bulk route cannot write it. */
  bulk: IssueBulkPatch | null;
  /** The old values, laid over a row so it shows the undo before the write lands. */
  restore: Partial<IssueRead>;
  /** The fields that changed, in a stable order. */
  fields: string[];
}

/** A nullable field's value, with an absent one read as null. */
const valueOf = (issue: IssueRead, field: PlainField): string | null =>
  issue[field] ?? null;

/** Whether two label lists hold the same labels in any order. */
const sameLabels = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((id) => right.includes(id));

/** The status a revert sends: triage for an issue that waited there, else its status. */
const statusBefore = (issue: IssueRead): string =>
  issue.in_triage === true ? TRIAGE_STATUS_ID : issue.status_id;

/**
 * The revert that takes `after` back to `before`, or null when no property an
 * undo covers moved between them.
 */
export const revertBetween = (
  before: IssueRead,
  after: IssueRead
): IssueRevert | null => {
  const patch: IssueUpdate = {};
  const bulk: IssueBulkPatch = {};
  const restore: Partial<IssueRead> = {};
  const fields: string[] = [];
  if (
    before.status_id !== after.status_id ||
    (before.in_triage === true) !== (after.in_triage === true)
  ) {
    patch.status_id = statusBefore(before);
    bulk.status_id = patch.status_id;
    restore.status_id = before.status_id;
    restore.in_triage = before.in_triage === true;
    fields.push('status_id');
  }
  for (const field of PLAIN_FIELDS) {
    const old = valueOf(before, field);
    if (old === valueOf(after, field)) continue;
    Object.assign(patch, { [field]: old });
    if (!SINGLE_ONLY.has(field)) Object.assign(bulk, { [field]: old });
    Object.assign(restore, { [field]: old });
    fields.push(field);
  }
  if (!sameLabels(before.label_ids, after.label_ids)) {
    patch.label_ids = [...before.label_ids];
    const added = before.label_ids.filter(
      (id) => !after.label_ids.includes(id)
    );
    const removed = after.label_ids.filter(
      (id) => !before.label_ids.includes(id)
    );
    if (added.length > 0) bulk.add_label_ids = added;
    if (removed.length > 0) bulk.remove_label_ids = removed;
    restore.label_ids = [...before.label_ids];
    fields.push('label_ids');
  }
  if (fields.length === 0) return null;
  return {
    issueId: before.id,
    patch,
    bulk: fields.some((field) => SINGLE_ONLY.has(field)) ? null : bulk,
    restore,
    fields,
  };
};

/**
 * The issue as a single issue patch leaves it, clearing the milestone when the
 * project moves without one, as the server does. Fields an undo does not
 * cover, such as the title, are left as they were.
 */
export const patchedIssue = (
  issue: IssueRead,
  patch: IssueUpdate
): IssueRead => {
  const { title: _title, body: _body, status_id: statusId, ...rest } = patch;
  const next: IssueRead = { ...issue, ...rest };
  if (statusId === TRIAGE_STATUS_ID) {
    next.in_triage = true;
  } else if (statusId !== undefined) {
    next.status_id = statusId;
    next.in_triage = false;
  }
  if (
    patch.project_id !== undefined &&
    patch.project_id !== issue.project_id &&
    patch.project_milestone_id === undefined
  ) {
    next.project_milestone_id = null;
  }
  return next;
};

/**
 * The notice a change raises: the field and issue for one, "Updated" when
 * several fields moved, and a count for many issues.
 */
export const describeChange = (
  reverts: readonly IssueRevert[],
  keyOf: (issueId: string) => string | undefined
): string => {
  const fields = [...new Set(reverts.flatMap((revert) => revert.fields))];
  const single = reverts.length === 1 ? reverts[0] : undefined;
  const subject =
    single === undefined
      ? `${String(reverts.length)} issues`
      : (keyOf(single.issueId) ?? 'issue');
  const field = fields.length === 1 ? fields[0] : undefined;
  return field === undefined
    ? `Updated ${subject}`
    : `Changed ${FIELD_NAMES[field] ?? 'issue'} of ${subject}`;
};

/** Splits a list into runs of at most `size`. */
const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
};

/**
 * Writes reverts back. Issues sharing one bulk revert go through the bulk
 * route in batches; the rest go one at a time. Each issue's own query and
 * activity re-read once the writes land, along with any `invalidate` keys.
 */
export const writeReverts = async (
  workspaceId: string,
  reverts: readonly IssueRevert[],
  invalidate: readonly QueryKey[] = []
): Promise<IssueRead[]> => {
  const groups = new Map<string, { bulk: IssueBulkPatch; ids: string[] }>();
  const singles: IssueRevert[] = [];
  for (const revert of reverts) {
    if (revert.bulk === null || reverts.length === 1) {
      singles.push(revert);
      continue;
    }
    const slot = JSON.stringify(revert.bulk);
    const group = groups.get(slot) ?? { bulk: revert.bulk, ids: [] };
    group.ids.push(revert.issueId);
    groups.set(slot, group);
  }
  for (const [slot, group] of groups) {
    if (group.ids.length > 1) continue;
    groups.delete(slot);
    const lone = reverts.find((revert) => revert.issueId === group.ids[0]);
    if (lone !== undefined) singles.push(lone);
  }
  try {
    const written = await Promise.all([
      ...singles.map((revert) =>
        updateIssue(workspaceId, revert.issueId, revert.patch).then((issue) => [
          issue,
        ])
      ),
      ...[...groups.values()].flatMap((group) =>
        chunks(group.ids, BULK_MAX_ISSUES).map((part) =>
          bulkUpdateIssues(workspaceId, {
            issue_ids: part,
            patch: group.bulk,
          }).then((answer): IssueRead[] => answer.issues)
        )
      ),
    ]);
    return written.flat();
  } finally {
    invalidateQueries([
      ...invalidate,
      ...reverts.flatMap((revert) => [
        issueKey(workspaceId, revert.issueId),
        activityKey(revert.issueId),
      ]),
    ]);
  }
};

/** Options for {@link recordIssueChange}. */
export interface RecordOptions {
  /** Queries that re-read once the undo lands, beside each issue's own. */
  invalidate?: readonly QueryKey[];
  /** Takes the issues the undo wrote, for a surface holding them. */
  onReverted?: (issues: IssueRead[]) => void;
  /** The notice, overriding the one built from the change. */
  message?: string;
}

/**
 * Records a landed change to one or more issues as an undo entry, from each
 * issue before and after it, and raises its notice. Answers false, recording
 * nothing, when no property an undo covers moved.
 */
export const recordIssueChange = (
  workspaceId: string,
  changes: readonly { before: IssueRead; after: IssueRead }[],
  options: RecordOptions = {}
): boolean => {
  const reverts = changes.flatMap(({ before, after }) => {
    const revert = revertBetween(before, after);
    return revert === null ? [] : [revert];
  });
  if (reverts.length === 0) return false;
  const keys = new Map(changes.map(({ before }) => [before.id, before.key]));
  pushUndo(
    workspaceId,
    options.message ?? describeChange(reverts, (id) => keys.get(id)),
    async () => {
      const written = await writeReverts(
        workspaceId,
        reverts,
        options.invalidate
      );
      options.onReverted?.(written);
    }
  );
  return true;
};

/**
 * Records a landed single issue patch for undo, from the issue as it was
 * before the patch. Answers false when the patch moved nothing an undo covers.
 */
export const recordPatch = (
  workspaceId: string,
  before: IssueRead,
  patch: IssueUpdate,
  options: RecordOptions = {}
): boolean =>
  recordIssueChange(
    workspaceId,
    [{ before, after: patchedIssue(before, patch) }],
    options
  );

/**
 * Records an archive or a restore of the given issues, undone by the bulk
 * route's opposite. `restored` is true when the change was a restore.
 */
export const recordArchive = (
  workspaceId: string,
  issues: readonly Pick<IssueRead, 'id' | 'key'>[],
  restored: boolean,
  options: Omit<RecordOptions, 'message'> = {}
): void => {
  if (issues.length === 0) return;
  const verb = restored ? 'Restored' : 'Archived';
  const first = issues[0];
  const subject =
    issues.length === 1 && first !== undefined
      ? first.key
      : `${String(issues.length)} issues`;
  pushUndo(workspaceId, `${verb} ${subject}`, async () => {
    const ids = issues.map((issue) => issue.id);
    try {
      const answers = await Promise.all(
        chunks(ids, BULK_MAX_ISSUES).map((part) =>
          bulkUpdateIssues(workspaceId, {
            issue_ids: part,
            patch: { archived: restored },
          })
        )
      );
      options.onReverted?.(
        answers.flatMap((answer): IssueRead[] => answer.issues)
      );
    } finally {
      invalidateQueries([
        ...(options.invalidate ?? []),
        ...ids.flatMap((id) => [issueKey(workspaceId, id), activityKey(id)]),
      ]);
    }
  });
};

/**
 * Records a move to another team, undone by moving the issue back and then
 * putting back what the move dropped, such as its status, labels and cycle.
 */
export const recordMove = (
  workspaceId: string,
  before: IssueRead,
  message: string,
  options: Omit<RecordOptions, 'message'> = {}
): void => {
  pushUndo(workspaceId, message, async () => {
    try {
      const back = await moveIssue(workspaceId, before.id, before.team_id);
      const revert = revertBetween(before, back);
      const restored =
        revert === null
          ? back
          : await updateIssue(workspaceId, before.id, revert.patch);
      options.onReverted?.([restored]);
    } finally {
      invalidateQueries([
        ...(options.invalidate ?? []),
        issueKey(workspaceId, before.id),
        activityKey(before.id),
      ]);
    }
  });
};
