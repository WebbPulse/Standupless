/**
 * Filing several sub-issues of one parent at once, from a selected list,
 * pasted lines or a comment. Each child inherits what Linear carries down: the
 * parent's team, priority and project, never its labels. Children are filed one
 * at a time in the order given, so their keys read in the same order, and a
 * failure stops the run and keeps the ones already filed.
 */

import { invalidateQueries } from '@webbpulse/api-client/react';
import { createIssue, getIssue } from '../api/issues';
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
}

/** A parent with every field a child inherits read. */
export interface ResolvedSubIssueParent {
  id: string;
  key: string;
  teamId: string;
  priority: IssuePriority;
  projectId: string | null;
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

/** A parent as an issue row describes it. */
export const parentOfIssue = (
  issue: Pick<IssueRead, 'id' | 'key' | 'team_id' | 'priority' | 'project_id'>
): ResolvedSubIssueParent => ({
  id: issue.id,
  key: issue.key,
  teamId: issue.team_id,
  priority: issue.priority,
  projectId: issue.project_id ?? null,
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
    return { id: parent.id, key, teamId, priority, projectId };
  }
  return parentOfIssue(await getIssue(workspaceId, parent.id));
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
