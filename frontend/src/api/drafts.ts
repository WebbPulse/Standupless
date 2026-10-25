/**
 * The comment draft routes: the caller's unposted comments, one per issue,
 * document or update reply thread, and one per reply thread of an issue or
 * document comment. Drafts are the caller's own, saved as they type and
 * restored when the composer opens again, and posting the comment clears its
 * draft on the server too.
 *
 * Status updates on a project or an initiative keep a draft of the same kind,
 * one per target, holding the text and the health picked so far.
 */

import apiClient, { isApiErrorWithStatus } from './client';
import type {
  DraftListRead,
  DraftRead,
  DraftWrite,
  UpdateDraftRead,
  UpdateDraftTargetKind,
  UpdateDraftWrite,
} from '../types/Api';

/** The route the caller's drafts are listed on. */
export const draftsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/drafts`;

/** The route one issue's draft is read, saved and discarded through. */
export const issueDraftPath = (workspaceId: string, issueId: string): string =>
  `${draftsPath(workspaceId)}/${issueId}`;

/** The thread a comment draft sits on: an issue, a document, or the reply thread of an update. */
export type CommentDraftParent =
  | { kind: 'issue'; id: string }
  | { kind: 'document'; id: string }
  | { kind: 'project_update'; projectId: string; updateId: string }
  | { kind: 'initiative_update'; initiativeId: string; updateId: string };

/** The route one parent's draft is read, saved and discarded through. */
export const commentDraftPath = (
  workspaceId: string,
  parent: CommentDraftParent
): string => {
  const base = draftsPath(workspaceId);
  if (parent.kind === 'document') return `${base}/documents/${parent.id}`;
  if (parent.kind === 'project_update')
    return `${base}/update-replies/projects/${parent.projectId}/${parent.updateId}`;
  if (parent.kind === 'initiative_update')
    return `${base}/update-replies/initiatives/${parent.initiativeId}/${parent.updateId}`;
  return issueDraftPath(workspaceId, parent.id);
};

/** The listing filter naming one parent. */
const parentQuery = (parent: CommentDraftParent): Record<string, string> => {
  if (parent.kind === 'document') return { document_id: parent.id };
  if (parent.kind === 'issue') return { issue_id: parent.id };
  return { update_id: parent.updateId };
};

/** The query naming a reply thread, empty for the parent's own thread. */
const threadQuery = (
  parentCommentId: string | null | undefined
): Record<string, string> =>
  parentCommentId ? { parent_comment_id: parentCommentId } : {};

/** Reads the caller's drafts on one parent, answering an empty list for a missing body. */
export const listIssueDrafts = async (
  workspaceId: string,
  parent: CommentDraftParent,
  signal?: AbortSignal
): Promise<DraftRead[]> => {
  const query = parentQuery(parent);
  const response = await apiClient.get<DraftListRead>(
    draftsPath(workspaceId),
    signal === undefined ? { query } : { query, signal }
  );
  return Array.isArray(response.data?.drafts) ? response.data.drafts : [];
};

/** Saves the caller's draft in one thread, replacing the one there. */
export const saveDraft = async (
  workspaceId: string,
  parent: CommentDraftParent,
  parentCommentId: string | null | undefined,
  body: string
): Promise<DraftRead> => {
  const write: DraftWrite = { body };
  const response = await apiClient.put<DraftRead>(
    commentDraftPath(workspaceId, parent),
    write,
    { query: threadQuery(parentCommentId) }
  );
  return response.data;
};

/** Discards the caller's draft in one thread. Discarding none is not an error. */
export const deleteDraft = async (
  workspaceId: string,
  parent: CommentDraftParent,
  parentCommentId: string | null | undefined
): Promise<void> => {
  await apiClient.delete<void>(commentDraftPath(workspaceId, parent), {
    query: threadQuery(parentCommentId),
  });
};

/** The project or initiative a status update draft sits on. */
export interface UpdateDraftTarget {
  workspaceId: string;
  kind: UpdateDraftTargetKind;
  id: string;
}

/** The route one target's status update draft is read, saved and discarded through. */
export const updateDraftPath = (target: UpdateDraftTarget): string =>
  target.kind === 'project'
    ? `/workspaces/${target.workspaceId}/drafts/updates/projects/${target.id}`
    : `/workspaces/${target.workspaceId}/drafts/updates/initiatives/${target.id}`;

/** Reads the caller's status update draft on a target, answering null when there is none. */
export const getUpdateDraft = async (
  target: UpdateDraftTarget,
  signal?: AbortSignal
): Promise<UpdateDraftRead | null> => {
  try {
    const response = await apiClient.get<UpdateDraftRead>(
      updateDraftPath(target),
      signal === undefined ? {} : { signal }
    );
    return response.data ?? null;
  } catch (error) {
    if (isApiErrorWithStatus(error) && error.status === 404) return null;
    throw error;
  }
};

/** Saves the caller's status update draft on a target, replacing the one there. */
export const saveUpdateDraft = async (
  target: UpdateDraftTarget,
  write: UpdateDraftWrite
): Promise<UpdateDraftRead> => {
  const response = await apiClient.put<UpdateDraftRead>(
    updateDraftPath(target),
    write
  );
  return response.data;
};

/** Discards the caller's status update draft on a target. Discarding none is not an error. */
export const deleteUpdateDraft = async (
  target: UpdateDraftTarget
): Promise<void> => {
  await apiClient.delete<void>(updateDraftPath(target));
};
