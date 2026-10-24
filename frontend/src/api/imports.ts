/**
 * Issue imports: an admin uploads a CSV from another tracker, dry runs it
 * against a team to see what every row would become, then starts a job that
 * writes the issues a page at a time and polls it until it finishes. A Linear
 * import reads a Linear workspace through its API with a pasted key instead,
 * which the server keeps only while the job runs, and an Asana import does the
 * same with a pasted personal access token. A GitHub import reads one
 * repository's Issues through the workspace's installed GitHub App. A Shortcut
 * import reads a Shortcut workspace with a pasted API token the same way.
 */

import apiClient from './client';
import type {
  AsanaImportPreviewRead,
  AsanaImportRequest,
  AsanaProjectListRead,
  AsanaProjectRead,
  GitHubImportRepositoryListRead,
  GitHubImportRepositoryRead,
  GitHubImportRequest,
  IssueImportListRead,
  IssueImportPreviewRead,
  IssueImportRead,
  IssueImportRequest,
  LinearImportRequest,
  LinearTeamListRead,
  LinearTeamRead,
  ShortcutImportPreviewRead,
  ShortcutImportRequest,
  ShortcutTeamListRead,
  ShortcutTeamRead,
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

/** Answers the Linear teams a personal API key can read. The key is not kept. */
export const listLinearTeams = async (
  workspaceId: string,
  apiKey: string
): Promise<LinearTeamRead[]> => {
  const response = await apiClient.post<Partial<LinearTeamListRead>>(
    `${issueImportsPath(workspaceId)}/linear/teams`,
    { api_key: apiKey }
  );
  const items = response.data?.items;
  return Array.isArray(items) ? items : [];
};

/** Starts a Linear import. Refused with 409 while another is running in the workspace. */
export const startLinearImport = async (
  workspaceId: string,
  body: LinearImportRequest
): Promise<IssueImportRead> => {
  const response = await apiClient.post<IssueImportRead>(
    `${issueImportsPath(workspaceId)}/linear`,
    body
  );
  return response.data;
};

/** Answers the Shortcut teams an API token can read. The token is not kept. */
export const listShortcutTeams = async (
  workspaceId: string,
  apiToken: string
): Promise<ShortcutTeamRead[]> => {
  const response = await apiClient.post<Partial<ShortcutTeamListRead>>(
    `${issueImportsPath(workspaceId)}/shortcut/teams`,
    { api_token: apiToken }
  );
  const items = response.data?.items;
  return Array.isArray(items) ? items : [];
};

/** Answers the Asana projects a personal access token can read. The token is not kept. */
export const listAsanaProjects = async (
  workspaceId: string,
  token: string
): Promise<AsanaProjectRead[]> => {
  const response = await apiClient.post<Partial<AsanaProjectListRead>>(
    `${issueImportsPath(workspaceId)}/asana/projects`,
    { token }
  );
  const items = response.data?.items;
  return Array.isArray(items) ? items : [];
};

/** Answers what a Shortcut import would bring over, writing nothing. The token is not kept. */
export const previewShortcutImport = async (
  workspaceId: string,
  body: ShortcutImportRequest
): Promise<ShortcutImportPreviewRead> => {
  const response = await apiClient.post<ShortcutImportPreviewRead>(
    `${issueImportsPath(workspaceId)}/shortcut/preview`,
    body
  );
  return response.data;
};

/** Reads the chosen Asana projects and answers what importing them would do, writing nothing. */
export const previewAsanaImport = async (
  workspaceId: string,
  body: AsanaImportRequest
): Promise<AsanaImportPreviewRead> => {
  const response = await apiClient.post<AsanaImportPreviewRead>(
    `${issueImportsPath(workspaceId)}/asana/preview`,
    body
  );
  return response.data;
};

/** Starts a Shortcut import. Refused with 409 while another is running in the workspace. */
export const startShortcutImport = async (
  workspaceId: string,
  body: ShortcutImportRequest
): Promise<IssueImportRead> => {
  const response = await apiClient.post<IssueImportRead>(
    `${issueImportsPath(workspaceId)}/shortcut`,
    body
  );
  return response.data;
};

/** Starts an Asana import. Refused with 409 while another is running in the workspace. */
export const startAsanaImport = async (
  workspaceId: string,
  body: AsanaImportRequest
): Promise<IssueImportRead> => {
  const response = await apiClient.post<IssueImportRead>(
    `${issueImportsPath(workspaceId)}/asana`,
    body
  );
  return response.data;
};

/** The repository list body, any field of which may be missing. */
type RepositoryList = Partial<GitHubImportRepositoryListRead>;

/** Lists the repositories the installed GitHub App covers, empty when it is missing or suspended. */
export const listGitHubImportRepositories = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<GitHubImportRepositoryRead[]> => {
  const response = await apiClient.get<RepositoryList>(
    `${issueImportsPath(workspaceId)}/github/repositories`,
    signalOptions(signal)
  );
  const items = response.data?.items;
  return Array.isArray(items) ? items : [];
};

/** Starts a GitHub import. Refused with 409 while another is running in the workspace. */
export const startGitHubImport = async (
  workspaceId: string,
  body: GitHubImportRequest
): Promise<IssueImportRead> => {
  const response = await apiClient.post<IssueImportRead>(
    `${issueImportsPath(workspaceId)}/github`,
    body
  );
  return response.data;
};

/** Stops a queued or running import, keeping what it already wrote. */
export const cancelIssueImport = async (
  workspaceId: string,
  importId: string
): Promise<IssueImportRead> => {
  const response = await apiClient.post<IssueImportRead>(
    `${issueImportPath(workspaceId, importId)}/cancel`
  );
  return response.data;
};
