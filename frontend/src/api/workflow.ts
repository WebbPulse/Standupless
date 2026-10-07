/**
 * The workspace workflow routes: the statuses and labels every team of a
 * workspace inherits. Any member reads them; a workspace owner or admin
 * changes them, and each change reaches every team at once.
 */

import apiClient from './client';
import type {
  LabelCreate,
  LabelListRead,
  LabelRead,
  LabelUpdate,
  StatusCreate,
  StatusListRead,
  StatusRead,
  StatusUpdate,
} from '../types/Api';

/** The route a workspace's inherited statuses are read from. */
export const workspaceStatusesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/statuses`;

/** The route a workspace's inherited labels are read from. */
export const workspaceLabelsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/labels`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists the workspace statuses, ordered by position. */
export const listWorkspaceStatuses = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<StatusRead[]> => {
  const response = await apiClient.get<StatusListRead>(
    workspaceStatusesPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.statuses) ? body.statuses : [];
};

/** Adds a status every team inherits. */
export const createWorkspaceStatus = async (
  workspaceId: string,
  body: StatusCreate
): Promise<StatusRead> => {
  const response = await apiClient.post<StatusRead>(
    workspaceStatusesPath(workspaceId),
    body
  );
  return response.data;
};

/** Renames, recategorises, recolors or moves a workspace status for every team. */
export const updateWorkspaceStatus = async (
  workspaceId: string,
  statusId: string,
  body: StatusUpdate
): Promise<StatusRead> => {
  const response = await apiClient.patch<StatusRead>(
    `${workspaceStatusesPath(workspaceId)}/${statusId}`,
    body
  );
  return response.data;
};

/**
 * Deletes a workspace status, moving every team's issues in it to
 * `replacementStatusId`. The API refuses with a 409 when a team would lose its
 * last visible status of the category, when issues are in it and no
 * replacement is named, or when a team with issues there hides the replacement.
 */
export const deleteWorkspaceStatus = async (
  workspaceId: string,
  statusId: string,
  replacementStatusId?: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${workspaceStatusesPath(workspaceId)}/${statusId}`,
    replacementStatusId === undefined
      ? undefined
      : { query: { replacement_status_id: replacementStatusId } }
  );
};

/** Lists the workspace labels, in name order. */
export const listWorkspaceLabels = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<LabelRead[]> => {
  const response = await apiClient.get<LabelListRead>(
    workspaceLabelsPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.labels) ? body.labels : [];
};

/** Adds a label every team inherits. */
export const createWorkspaceLabel = async (
  workspaceId: string,
  body: LabelCreate
): Promise<LabelRead> => {
  const response = await apiClient.post<LabelRead>(
    workspaceLabelsPath(workspaceId),
    body
  );
  return response.data;
};

/** Renames or recolours a workspace label for every team. */
export const updateWorkspaceLabel = async (
  workspaceId: string,
  labelId: string,
  body: LabelUpdate
): Promise<LabelRead> => {
  const response = await apiClient.patch<LabelRead>(
    `${workspaceLabelsPath(workspaceId)}/${labelId}`,
    body
  );
  return response.data;
};

/** Deletes a workspace label, taking it off every team. */
export const deleteWorkspaceLabel = async (
  workspaceId: string,
  labelId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${workspaceLabelsPath(workspaceId)}/${labelId}`
  );
};
