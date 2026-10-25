/**
 * Filing several sub-issues of one parent at once, from a selected list,
 * pasted lines or a comment. Each child inherits what Linear carries down: the
 * parent's team, priority and project, never its labels. The server adds the
 * parent's open cycle for an active start and the parent's assignee under
 * Linear's rule whenever a create leaves them out, and {@link inheritedAssignee}
 * is that rule for pickers that show the assignee before the child is saved.
 * Children are filed one at a time in the order given, so their keys read in
 * the same order, and a failure stops the run and keeps the ones already filed.
 */

import { invalidateQueries } from '@webbpulse/api-client/react';
import { createIssue, getIssue } from '../api/issues';
import type { CreateIssueOptions } from '../hooks/useCreateIssue';
import type { IssueCreate, IssuePriority, IssueRead } from '../types/Api';
import { errorMessage } from './errors';
import { activityKey, childrenKey } from './queryKeys';
import { showErrorToast, showToast } from './toast';

/** The issue a sub-issue hangs off, with what a child inherits when known. */
export interface SubIssueParent {
  id: string;
  key?: string;
  teamId?: string;
  priority?: IssuePriority;
  projectId?: string | null;
  assigneeId?: string | null;
}

/**
 * A parent with every field a child inherits read. `assigneeId` is the
 * parent's assignee when it was read, for pickers that show it before saving.
 */
export interface ResolvedSubIssueParent {
  id: string;
  key: string;
  teamId: string;
  priority: IssuePriority;
  projectId: string | null;
  assigneeId?: string | null;
}

/** One sub-issue to file: its title and optionally a description. */
export interface SubIssueDraft {
  title: string;
  body?: string;
}

/** Fields a caller sets on every child beside what it inherits. */
export type SubIssueExtras = Pick<
  IssueCreate,
  'status_id' | 'priority' | 'assignee_id'
>;

/**
 * The assignee a new sub-issue starts with, as Linear picks it: the parent's
 * assignee when the creator is that assignee, or when every existing sub-issue
 * shares it, none at all counting as sharing. Null when the parent has no
 * assignee, when siblings differ, or when the siblings are not known yet, so
 * the server's own rule decides.
 */
export const inheritedAssignee = (
  parentAssigneeId: string | null | undefined,
  creatorId: string | undefined,
  siblingAssigneeIds: readonly (string | null | undefined)[] | undefined
): string | null => {
  if (
    parentAssigneeId === null ||
    parentAssigneeId === undefined ||
    parentAssigneeId === ''
  ) {
    return null;
  }
  if (creatorId === parentAssigneeId) return parentAssigneeId;
  if (siblingAssigneeIds === undefined) return null;
  return siblingAssigneeIds.every((id) => id === parentAssigneeId)
    ? parentAssigneeId
    : null;
};

/** A parent as an issue row describes it. */
export const parentOfIssue = (
  issue: Pick<IssueRead, 'id' | 'key' | 'team_id' | 'priority' | 'project_id'> &
    Partial<Pick<IssueRead, 'assignee_id'>>
): ResolvedSubIssueParent => ({
  id: issue.id,
  key: issue.key,
  teamId: issue.team_id,
  priority: issue.priority,
  projectId: issue.project_id ?? null,
  ...(issue.assignee_id === undefined ? {} : { assigneeId: issue.assignee_id }),
});

/** The parent with its inherited fields, read from the issue when not given. */
export const resolveSubIssueParent = async (
  workspaceId: string,
  parent: SubIssueParent
): Promise<ResolvedSubIssueParent> => {
  const { key, teamId, priority, projectId } = parent;
  if (
    key !== undefined &&
    teamId !== undefined &&
    priority !== undefined &&
    projectId !== undefined
  ) {
    return {
      id: parent.id,
      key,
      teamId,
      priority,
      projectId,
      ...(parent.assigneeId === undefined
        ? {}
        : { assigneeId: parent.assigneeId }),
    };
  }
  return parentOfIssue(await getIssue(workspaceId, parent.id));
};

/** Who is filing a sub-issue and, when known, its siblings' assignees. */
export interface SubIssueCreator {
  creatorId?: string;
  siblingAssigneeIds?: readonly (string | null | undefined)[];
}

/**
 * The create dialog presets for one child: the parent's team, key, priority
 * and project, never its labels, and the assignee {@link inheritedAssignee}
 * gives for the creator.
 */
export const subIssueDialogPresets = (
  parent: ResolvedSubIssueParent,
  creator: SubIssueCreator = {}
): Pick<
  CreateIssueOptions,
  'teamId' | 'parentId' | 'parentKey' | 'priority' | 'projectId' | 'assigneeId'
> => {
  const assigneeId = inheritedAssignee(
    parent.assigneeId,
    creator.creatorId,
    creator.siblingAssigneeIds
  );
  return {
    teamId: parent.teamId,
    parentId: parent.id,
    parentKey: parent.key,
    ...(parent.priority === 'none' ? {} : { priority: parent.priority }),
    ...(parent.projectId === null ? {} : { projectId: parent.projectId }),
    ...(assigneeId === null ? {} : { assigneeId }),
  };
};

/**
 * The create body for one child: the parent's team, priority and project, the
 * caller's extras over them, and the draft's title and description.
 */
export const subIssueBody = (
  parent: ResolvedSubIssueParent,
  draft: SubIssueDraft,
  extras: SubIssueExtras = {}
): IssueCreate => ({
  team_id: parent.teamId,
  parent_id: parent.id,
  title: draft.title,
  ...(draft.body === undefined || draft.body === ''
    ? {}
    : { body: draft.body }),
  ...(parent.priority === 'none' ? {} : { priority: parent.priority }),
  ...(parent.projectId === null ? {} : { project_id: parent.projectId }),
  ...extras,
});

/** What a run filed, and the error that stopped it, if one did. */
export interface SubIssueRun {
  created: IssueRead[];
  failed: unknown;
}

/**
 * Files the drafts as children of the parent, in order, then refreshes the
 * parent's sub-issues and activity. A toast says how many were filed, or why
 * the run stopped.
 */
export const createSubIssues = async (
  workspaceId: string,
  parent: SubIssueParent,
  drafts: readonly SubIssueDraft[],
  extras: SubIssueExtras = {}
): Promise<SubIssueRun> => {
  const created: IssueRead[] = [];
  let failed: unknown = null;
  try {
    const resolved = await resolveSubIssueParent(workspaceId, parent);
    for (const draft of drafts) {
      created.push(
        await createIssue(workspaceId, subIssueBody(resolved, draft, extras))
      );
    }
  } catch (cause) {
    failed = cause;
  }
  if (created.length > 0) {
    invalidateQueries([childrenKey(parent.id), activityKey(parent.id)]);
  }
  if (failed !== null) {
    const message = errorMessage(failed, 'Could not create those sub-issues.');
    showErrorToast(
      created.length === 0
        ? message
        : `Created ${String(created.length)} of ${String(drafts.length)} sub-issues. ${message}`
    );
  } else if (created.length > 1) {
    showToast(`Created ${String(created.length)} sub-issues`);
  } else if (created.length === 1) {
    showToast(`Created sub-issue ${created[0]?.key ?? ''}`.trim());
  }
  return { created, failed };
};
