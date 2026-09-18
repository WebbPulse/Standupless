/**
 * Reads the workspaces the signed in user belongs to.
 */

import apiClient from './client';
import type { WorkspaceListRead, WorkspaceRead } from '../types/Api';

/** The route the workspace list is read from. */
export const WORKSPACES_PATH = '/workspaces';

/**
 * Lists the caller's workspaces. The backend answers the
 * `{"workspaces": [...]}` envelope, so the items are read out of it; a body
 * missing the array answers an empty list rather than throwing, which keeps a
 * malformed response from blanking the page.
 */
export const listWorkspaces = async (
  signal?: AbortSignal
): Promise<WorkspaceRead[]> => {
  const response = await apiClient.get<WorkspaceListRead>(
    WORKSPACES_PATH,
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  return Array.isArray(body?.workspaces) ? body.workspaces : [];
};
