/**
 * The comment draft routes: the caller's unposted comments, one per issue and
 * one per reply thread. Drafts are the caller's own, saved as they type and
 * restored when the composer opens again, and posting the comment clears its
 * draft on the server too.
 */

import apiClient from './client';
import type { DraftListRead, DraftRead, DraftWrite } from '../types/Api';

/** The route the caller's drafts are listed on. */
export const draftsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/drafts`;

/** The route one issue's draft is read, saved and discarded through. */
export const issueDraftPath = (workspaceId: string, issueId: string): string =>
  `${draftsPath(workspaceId)}/${issueId}`;

/** The query naming a reply thread, empty for the issue's own thread. */
const threadQuery = (
  parentCommentId: string | null | undefined
): Record<string, string> =>
  parentCommentId ? { parent_comment_id: parentCommentId } : {};

/** Reads the caller's drafts on one issue, answering an empty list for a missing body. */
export const listIssueDrafts = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<DraftRead[]> => {
  const response = await apiClient.get<DraftListRead>(
    draftsPath(workspaceId),
    signal === undefined
      ? { query: { issue_id: issueId } }
      : { query: { issue_id: issueId }, signal }
  );
  return Array.isArray(response.data?.drafts) ? response.data.drafts : [];
};

/** Saves the caller's draft in one thread, replacing the one there. */
export const saveDraft = async (
  workspaceId: string,
  issueId: string,
  parentCommentId: string | null | undefined,
  body: string
): Promise<DraftRead> => {
  const write: DraftWrite = { body };
  const response = await apiClient.put<DraftRead>(
    issueDraftPath(workspaceId, issueId),
    write,
    { query: threadQuery(parentCommentId) }
  );
  return response.data;
};

/** Discards the caller's draft in one thread. Discarding none is not an error. */
export const deleteDraft = async (
  workspaceId: string,
  issueId: string,
  parentCommentId: string | null | undefined
): Promise<void> => {
  await apiClient.delete<void>(issueDraftPath(workspaceId, issueId), {
    query: threadQuery(parentCommentId),
  });
};
