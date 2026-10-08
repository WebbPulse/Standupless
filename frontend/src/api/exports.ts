/**
 * Workspace exports: an admin starts a job that writes the whole workspace as
 * a zip of NDJSON files, polls it, and reads it again for a download link. The
 * link is minted fresh on each read of one job and lasts minutes, so a page
 * fetches it at the moment of the click rather than holding one.
 */

import apiClient from './client';
import type {
  WorkspaceExportCreate,
  WorkspaceExportListRead,
  WorkspaceExportRead,
} from '../types/Api';

/** The route a workspace's exports are started and listed on. */
export const workspaceExportsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/exports`;

/** The route one export job is read through. */
export const workspaceExportPath = (
  workspaceId: string,
  exportId: string
): string =>
  `${workspaceExportsPath(workspaceId)}/${encodeURIComponent(exportId)}`;

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Starts an export of the whole workspace. Refused with 409 while one is running. */
export const startWorkspaceExport = async (
  workspaceId: string,
  body: WorkspaceExportCreate = {}
): Promise<WorkspaceExportRead> => {
  const response = await apiClient.post<WorkspaceExportRead>(
    workspaceExportsPath(workspaceId),
    body
  );
  return response.data;
};

/** Lists the workspace's recent exports, answering an empty list for a malformed body. */
export const listWorkspaceExports = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<WorkspaceExportRead[]> => {
  const response = await apiClient.get<Partial<WorkspaceExportListRead>>(
    workspaceExportsPath(workspaceId),
    signalOptions(signal)
  );
  const items = response.data?.items;
  return Array.isArray(items) ? items : [];
};

/** Reads one export, with a fresh download link when it is ready. */
export const getWorkspaceExport = async (
  workspaceId: string,
  exportId: string,
  signal?: AbortSignal
): Promise<WorkspaceExportRead> => {
  const response = await apiClient.get<WorkspaceExportRead>(
    workspaceExportPath(workspaceId, exportId),
    signalOptions(signal)
  );
  return response.data;
};
