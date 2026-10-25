/**
 * The project status routes: the workspace's own stages inside the six fixed
 * project status categories. Any member reads them; a workspace owner or admin
 * adds, renames, recolours, reorders and deletes them, and a deleted status
 * moves its projects onto a replacement in the same category.
 */

import apiClient from './client';
import type {
  ProjectStatusCreate,
  ProjectStatusListRead,
  ProjectStatusRead,
  ProjectStatusUpdate,
} from '../types/Api';

/** The route a workspace's project statuses are read from. */
export const projectStatusesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/project-statuses`;

/** Lists the workspace's project statuses, by category then position. */
export const listProjectStatuses = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<ProjectStatusRead[]> => {
  const response = await apiClient.get<ProjectStatusListRead>(
    projectStatusesPath(workspaceId),
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  return Array.isArray(body?.statuses) ? body.statuses : [];
};

/** Adds a project status to a category; a taken name answers 409. */
export const createProjectStatus = async (
  workspaceId: string,
  body: ProjectStatusCreate
): Promise<ProjectStatusRead> => {
  const response = await apiClient.post<ProjectStatusRead>(
    projectStatusesPath(workspaceId),
    body
  );
  return response.data;
};

/** Renames, recolours, redescribes or moves a project status within its category. */
export const updateProjectStatus = async (
  workspaceId: string,
  statusId: string,
  body: ProjectStatusUpdate
): Promise<ProjectStatusRead> => {
  const response = await apiClient.patch<ProjectStatusRead>(
    `${projectStatusesPath(workspaceId)}/${statusId}`,
    body
  );
  return response.data;
};

/**
 * Deletes a project status, moving its projects to `replacementId`, or to the
 * category's first other status without one.
 */
export const deleteProjectStatus = async (
  workspaceId: string,
  statusId: string,
  replacementId?: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${projectStatusesPath(workspaceId)}/${statusId}`,
    replacementId === undefined
      ? undefined
      : { query: { replacement_status_id: replacementId } }
  );
};
