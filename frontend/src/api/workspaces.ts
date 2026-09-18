/**
 * Reads the workspaces the signed in user belongs to.
 */

import apiClient from './client';
import type { WorkspaceListRead, WorkspaceRead } from '../types/Api';

/** The route the workspace list is read from. */
export const WORKSPACES_PATH = '/workspaces';

/**
 * Lists the caller's workspaces. Accepts either a bare array or the enveloped
 * body, since the backend has not settled on one, and answers an empty list for
 * anything else.
 */
export const listWorkspaces = async (
  signal?: AbortSignal
): Promise<WorkspaceRead[]> => {
  const response = await apiClient.get<WorkspaceListRead | WorkspaceRead[]>(
    WORKSPACES_PATH,
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.workspaces) ? body.workspaces : [];
};
