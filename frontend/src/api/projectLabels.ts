/**
 * The project label routes: the workspace's one set of labels for projects.
 * Any member reads them; a workspace owner or admin adds, edits and deletes
 * them, and a deleted label leaves every project that carried it.
 */

import apiClient from './client';
import type {
  ProjectLabelCreate,
  ProjectLabelListRead,
  ProjectLabelRead,
  ProjectLabelUpdate,
} from '../types/Api';

/** The route a workspace's project labels are read from. */
export const projectLabelsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/project-labels`;

/** Lists the workspace's project labels, in name order. */
export const listProjectLabels = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<ProjectLabelRead[]> => {
  const response = await apiClient.get<ProjectLabelListRead>(
    projectLabelsPath(workspaceId),
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  return Array.isArray(body?.labels) ? body.labels : [];
};

/** Adds a project label; a taken name answers 409. */
export const createProjectLabel = async (
  workspaceId: string,
  body: ProjectLabelCreate
): Promise<ProjectLabelRead> => {
  const response = await apiClient.post<ProjectLabelRead>(
    projectLabelsPath(workspaceId),
    body
  );
  return response.data;
};

/** Renames, recolours or redescribes a project label. */
export const updateProjectLabel = async (
  workspaceId: string,
  labelId: string,
  body: ProjectLabelUpdate
): Promise<ProjectLabelRead> => {
  const response = await apiClient.patch<ProjectLabelRead>(
    `${projectLabelsPath(workspaceId)}/${labelId}`,
    body
  );
  return response.data;
};

/** Deletes a project label and takes it off every project. */
export const deleteProjectLabel = async (
  workspaceId: string,
  labelId: string
): Promise<void> => {
  await apiClient.delete<void>(`${projectLabelsPath(workspaceId)}/${labelId}`);
};
