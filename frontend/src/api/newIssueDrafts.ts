/**
 * The new issue draft routes: the caller's unfiled issues from the create
 * dialog, many per person, kept on the server so they follow the person from
 * one device to the next. The client names each draft, so a save is a PUT
 * that creates or replaces it.
 */

import apiClient from './client';
import type {
  IssueDraftListRead,
  IssueDraftRead,
  IssueDraftWrite,
} from '../types/Api';

/** The route the caller's new issue drafts are listed on. */
export const newIssueDraftsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/drafts/new-issues`;

/** The route one new issue draft is read, saved and discarded through. */
export const newIssueDraftPath = (
  workspaceId: string,
  draftId: string
): string => `${newIssueDraftsPath(workspaceId)}/${draftId}`;

/** Reads the caller's new issue drafts, newest first, reading a missing body as none. */
export const listNewIssueDrafts = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<IssueDraftRead[]> => {
  const response = await apiClient.get<IssueDraftListRead>(
    newIssueDraftsPath(workspaceId),
    signal === undefined ? {} : { signal }
  );
  return Array.isArray(response.data?.drafts) ? response.data.drafts : [];
};

/** Saves one new issue draft under its id, creating or replacing it. */
export const saveNewIssueDraft = async (
  workspaceId: string,
  draftId: string,
  write: IssueDraftWrite
): Promise<IssueDraftRead> => {
  const response = await apiClient.put<IssueDraftRead>(
    newIssueDraftPath(workspaceId, draftId),
    write
  );
  return response.data;
};

/** Discards one new issue draft. Discarding none is not an error. */
export const deleteNewIssueDraft = async (
  workspaceId: string,
  draftId: string
): Promise<void> => {
  await apiClient.delete<void>(newIssueDraftPath(workspaceId, draftId));
};
