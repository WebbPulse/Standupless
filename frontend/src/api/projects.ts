/**
 * The project routes: projects, their members, their statuses and their labels.
 * Every path is workspace scoped, because the contract never exposes a project
 * outside its tenant.
 */

import apiClient from './client';
import type {
  LabelCreate,
  LabelListRead,
  LabelRead,
  LabelUpdate,
  ProjectCreate,
  ProjectListRead,
  ProjectMemberListRead,
  ProjectMemberRead,
  ProjectMemberUpdate,
  ProjectRead,
  ProjectUpdate,
  StatusCreate,
  StatusListRead,
  StatusRead,
  StatusUpdate,
} from '../types/Api';

/** The route a workspace's projects are read from. */
export const projectsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/projects`;

/** The route one project is read from. */
export const projectPath = (workspaceId: string, projectId: string): string =>
  `${projectsPath(workspaceId)}/${projectId}`;

/** The route a project's members are read from. */
export const projectMembersPath = (
  workspaceId: string,
  projectId: string
): string => `${projectPath(workspaceId, projectId)}/members`;

/** The route a project's statuses are read from. */
export const statusesPath = (workspaceId: string, projectId: string): string =>
  `${projectPath(workspaceId, projectId)}/statuses`;

/** The route a project's labels are read from. */
export const labelsPath = (workspaceId: string, projectId: string): string =>
  `${projectPath(workspaceId, projectId)}/labels`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists a workspace's projects. A guest sees only the ones they belong to. */
export const listProjects = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<ProjectRead[]> => {
  const response = await apiClient.get<ProjectListRead>(
    projectsPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.projects) ? body.projects : [];
};

/** Creates a project. The creator becomes its admin and statuses are seeded. */
export const createProject = async (
  workspaceId: string,
  body: ProjectCreate
): Promise<ProjectRead> => {
  const response = await apiClient.post<ProjectRead>(
    projectsPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one project. */
export const getProject = async (
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<ProjectRead> => {
  const response = await apiClient.get<ProjectRead>(
    projectPath(workspaceId, projectId),
    signalOptions(signal)
  );
  return response.data;
};

/** Updates a project's name, estimate scale or description. */
export const updateProject = async (
  workspaceId: string,
  projectId: string,
  body: ProjectUpdate
): Promise<ProjectRead> => {
  const response = await apiClient.patch<ProjectRead>(
    projectPath(workspaceId, projectId),
    body
  );
  return response.data;
};

/** Deletes a project. Workspace owner or admin only. */
export const deleteProject = async (
  workspaceId: string,
  projectId: string
): Promise<void> => {
  await apiClient.delete<void>(projectPath(workspaceId, projectId));
};

/** Lists a project's members. */
export const listProjectMembers = async (
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<ProjectMemberRead[]> => {
  const response = await apiClient.get<ProjectMemberListRead>(
    projectMembersPath(workspaceId, projectId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.members) ? body.members : [];
};

/**
 * Grants a project role. A PUT rather than a POST, because the contract makes
 * this an upsert on one user rather than an append to a collection.
 */
export const setProjectMember = async (
  workspaceId: string,
  projectId: string,
  userId: string,
  body: ProjectMemberUpdate
): Promise<ProjectMemberRead> => {
  const response = await apiClient.put<ProjectMemberRead>(
    `${projectMembersPath(workspaceId, projectId)}/${userId}`,
    body
  );
  return response.data;
};

/** Removes one project member. */
export const removeProjectMember = async (
  workspaceId: string,
  projectId: string,
  userId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${projectMembersPath(workspaceId, projectId)}/${userId}`
  );
};

/** Lists a project's statuses, which the API returns ordered by position. */
export const listStatuses = async (
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<StatusRead[]> => {
  const response = await apiClient.get<StatusListRead>(
    statusesPath(workspaceId, projectId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.statuses) ? body.statuses : [];
};

/** Adds a status. */
export const createStatus = async (
  workspaceId: string,
  projectId: string,
  body: StatusCreate
): Promise<StatusRead> => {
  const response = await apiClient.post<StatusRead>(
    statusesPath(workspaceId, projectId),
    body
  );
  return response.data;
};

/** Renames, recategorises or repositions a status. */
export const updateStatus = async (
  workspaceId: string,
  projectId: string,
  statusId: string,
  body: StatusUpdate
): Promise<StatusRead> => {
  const response = await apiClient.patch<StatusRead>(
    `${statusesPath(workspaceId, projectId)}/${statusId}`,
    body
  );
  return response.data;
};

/** Deletes a status. The API refuses the last one of its category with a 409. */
export const deleteStatus = async (
  workspaceId: string,
  projectId: string,
  statusId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${statusesPath(workspaceId, projectId)}/${statusId}`
  );
};

/** Lists a project's labels. */
export const listLabels = async (
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<LabelRead[]> => {
  const response = await apiClient.get<LabelListRead>(
    labelsPath(workspaceId, projectId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.labels) ? body.labels : [];
};

/** Adds a label. */
export const createLabel = async (
  workspaceId: string,
  projectId: string,
  body: LabelCreate
): Promise<LabelRead> => {
  const response = await apiClient.post<LabelRead>(
    labelsPath(workspaceId, projectId),
    body
  );
  return response.data;
};

/** Renames or recolours a label. */
export const updateLabel = async (
  workspaceId: string,
  projectId: string,
  labelId: string,
  body: LabelUpdate
): Promise<LabelRead> => {
  const response = await apiClient.patch<LabelRead>(
    `${labelsPath(workspaceId, projectId)}/${labelId}`,
    body
  );
  return response.data;
};

/** Deletes a label. */
export const deleteLabel = async (
  workspaceId: string,
  projectId: string,
  labelId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${labelsPath(workspaceId, projectId)}/${labelId}`
  );
};
