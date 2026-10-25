/**
 * Replies and reactions on project updates. A thread hangs off one update, so
 * every route sits under the update's own path, and a reaction names the reply
 * it is on by `comment_id` or leaves it out to react to the update itself.
 */

import apiClient from './client';
import type {
  ProjectUpdateCommentListRead,
  ProjectUpdateCommentRead,
  ProjectUpdateReactionWrite,
  ReactionGroup,
} from '../types/Api';

/**
 * The route one update lives at. Built here rather than imported from the
 * planning module, so a test that mocks that module whole still reaches these.
 */
const projectUpdatePath = (
  workspaceId: string,
  projectId: string,
  updateId: string
): string =>
  `/workspaces/${workspaceId}/projects/${projectId}/updates/${updateId}`;

/** The route an update's replies are listed and posted through. */
export const projectUpdateCommentsPath = (
  workspaceId: string,
  projectId: string,
  updateId: string
): string => `${projectUpdatePath(workspaceId, projectId, updateId)}/comments`;

/** The route one reply is edited and deleted through. */
const projectUpdateCommentPath = (
  workspaceId: string,
  projectId: string,
  updateId: string,
  commentId: string
): string =>
  `${projectUpdateCommentsPath(workspaceId, projectId, updateId)}/${commentId}`;

/** The route reactions on an update and its replies are toggled through. */
const projectUpdateReactionsPath = (
  workspaceId: string,
  projectId: string,
  updateId: string
): string => `${projectUpdatePath(workspaceId, projectId, updateId)}/reactions`;

/** Lists every reply on one update, oldest first. */
export const listProjectUpdateComments = async (
  workspaceId: string,
  projectId: string,
  updateId: string,
  signal?: AbortSignal
): Promise<ProjectUpdateCommentRead[]> => {
  const response = await apiClient.get<ProjectUpdateCommentListRead>(
    projectUpdateCommentsPath(workspaceId, projectId, updateId),
    signal === undefined ? {} : { signal }
  );
  const body = response.data;
  return Array.isArray(body?.comments) ? body.comments : [];
};

/** Replies on an update; the update's author and anyone mentioned are told. */
export const createProjectUpdateComment = async (
  workspaceId: string,
  projectId: string,
  updateId: string,
  body: string
): Promise<ProjectUpdateCommentRead> => {
  const response = await apiClient.post<ProjectUpdateCommentRead>(
    projectUpdateCommentsPath(workspaceId, projectId, updateId),
    { body }
  );
  return response.data;
};

/** Rewrites a reply, which its author or an admin may do. */
export const updateProjectUpdateComment = async (
  workspaceId: string,
  projectId: string,
  updateId: string,
  commentId: string,
  body: string
): Promise<ProjectUpdateCommentRead> => {
  const response = await apiClient.patch<ProjectUpdateCommentRead>(
    projectUpdateCommentPath(workspaceId, projectId, updateId, commentId),
    { body }
  );
  return response.data;
};

/** Deletes a reply and its reactions. */
export const deleteProjectUpdateComment = async (
  workspaceId: string,
  projectId: string,
  updateId: string,
  commentId: string
): Promise<void> => {
  await apiClient.delete<void>(
    projectUpdateCommentPath(workspaceId, projectId, updateId, commentId)
  );
};

/** Adds the caller's reaction to an update or one of its replies. */
export const addProjectUpdateReaction = async (
  workspaceId: string,
  projectId: string,
  updateId: string,
  body: ProjectUpdateReactionWrite
): Promise<ReactionGroup> => {
  const response = await apiClient.put<ReactionGroup>(
    projectUpdateReactionsPath(workspaceId, projectId, updateId),
    body
  );
  return response.data;
};

/** Takes the caller's reaction off an update or one of its replies. */
export const removeProjectUpdateReaction = async (
  workspaceId: string,
  projectId: string,
  updateId: string,
  target: ProjectUpdateReactionWrite
): Promise<void> => {
  await apiClient.delete<void>(
    projectUpdateReactionsPath(workspaceId, projectId, updateId),
    { query: { emoji: target.emoji, comment_id: target.comment_id } }
  );
};
