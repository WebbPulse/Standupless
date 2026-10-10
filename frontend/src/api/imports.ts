/**
 * Issue imports: an admin uploads a CSV from another tracker, dry runs it
 * against a team to see what every row would become, then starts a job that
 * writes the issues a page at a time and polls it until it finishes.
 */

import apiClient from './client';
import type {
  IssueImportListRead,
  IssueImportPreviewRead,
  IssueImportRead,
  IssueImportRequest,
} from '../types/Api';

/** The route a workspace's imports are started and listed on. */
export const issueImportsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/imports`;

/** The route one import job is read through. */
export const issueImportPath = (
  workspaceId: string,
  importId: string
): string => `${issueImportsPath(workspaceId)}/${encodeURIComponent(importId)}`;

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Reads a file against a team and answers what an import would do, writing nothing. */
export const previewIssueImport = async (
  workspaceId: string,
  body: IssueImportRequest
): Promise<IssueImportPreviewRead> => {
  const response = await apiClient.post<IssueImportPreviewRead>(
    `${issueImportsPath(workspaceId)}/preview`,
    body
  );
  return response.data;
};

/** Starts an import. Refused with 409 while another is running in the workspace. */
export const startIssueImport = async (
  workspaceId: string,
  body: IssueImportRequest
): Promise<IssueImportRead> => {
  const response = await apiClient.post<IssueImportRead>(
    issueImportsPath(workspaceId),
    body
  );
  return response.data;
};

/** Lists the workspace's recent imports, answering an empty list for a malformed body. */
export const listIssueImports = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<IssueImportRead[]> => {
  const response = await apiClient.get<Partial<IssueImportListRead>>(
    issueImportsPath(workspaceId),
    signalOptions(signal)
  );
  const items = response.data?.items;
  return Array.isArray(items) ? items : [];
};

/** Reads one import with its row problems. */
export const getIssueImport = async (
  workspaceId: string,
  importId: string,
  signal?: AbortSignal
): Promise<IssueImportRead> => {
  const response = await apiClient.get<IssueImportRead>(
    issueImportPath(workspaceId, importId),
    signalOptions(signal)
  );
  return response.data;
};
