/**
 * The initiative routes: workspace level groups of projects across teams,
 * their project membership and their written status updates. A project sits in
 * at most one initiative, so adding it here moves it out of any other.
 */

import apiClient from './client';
import type {
  InitiativeCreate,
  InitiativeListQuery,
  InitiativeListRead,
  InitiativeRead,
  InitiativeUpdate,
  InitiativeUpdateListRead,
  InitiativeUpdateRead,
  ProjectRead,
  ProjectUpdateCreate,
  ProjectUpdateEdit,
  ProjectUpdateListQuery,
} from '../types/Api';

/** The route initiatives are listed and created on. */
export const initiativesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/initiatives`;

/** The route one initiative is read, edited and deleted through. */
export const initiativePath = (
  workspaceId: string,
  initiativeId: string
): string => `${initiativesPath(workspaceId)}/${initiativeId}`;

/** The route one project is added to or removed from an initiative through. */
export const initiativeProjectPath = (
  workspaceId: string,
  initiativeId: string,
  projectId: string
): string =>
  `${initiativePath(workspaceId, initiativeId)}/projects/${projectId}`;

/** The route one initiative's updates are listed and posted on. */
export const initiativeUpdatesPath = (
  workspaceId: string,
  initiativeId: string
): string => `${initiativePath(workspaceId, initiativeId)}/updates`;

/** The route one initiative update is edited and deleted through. */
export const initiativeUpdatePath = (
  workspaceId: string,
  initiativeId: string,
  updateId: string
): string => `${initiativeUpdatesPath(workspaceId, initiativeId)}/${updateId}`;

type QueryBag = Record<string, string | number | boolean | undefined>;

const listOptions = (
  query: QueryBag,
  signal?: AbortSignal
): { query: QueryBag; signal?: AbortSignal } =>
  signal === undefined ? { query } : { query, signal };

/** Lists one page of the workspace's initiatives by target date. */
export const listInitiatives = async (
  workspaceId: string,
  query: InitiativeListQuery = {},
  signal?: AbortSignal
): Promise<InitiativeListRead> => {
  const response = await apiClient.get<InitiativeListRead>(
    initiativesPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    initiatives: Array.isArray(body?.initiatives) ? body.initiatives : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** Creates an initiative. */
export const createInitiative = async (
  workspaceId: string,
  body: InitiativeCreate
): Promise<InitiativeRead> => {
  const response = await apiClient.post<InitiativeRead>(
    initiativesPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one initiative with its project rollup. */
export const getInitiative = async (
  workspaceId: string,
  initiativeId: string,
  signal?: AbortSignal
): Promise<InitiativeRead> => {
  const response = await apiClient.get<InitiativeRead>(
    initiativePath(workspaceId, initiativeId),
    listOptions({}, signal)
  );
  return response.data;
};

/** Edits an initiative. A null clears the owner or the target date. */
export const updateInitiative = async (
  workspaceId: string,
  initiativeId: string,
  body: InitiativeUpdate
): Promise<InitiativeRead> => {
  const response = await apiClient.patch<InitiativeRead>(
    initiativePath(workspaceId, initiativeId),
    body
  );
  return response.data;
};

/** Deletes an initiative and its updates; its projects stay. */
export const deleteInitiative = async (
  workspaceId: string,
  initiativeId: string
): Promise<void> => {
  await apiClient.delete<void>(initiativePath(workspaceId, initiativeId));
};

/** Puts a project in an initiative, moving it out of any other. */
export const addInitiativeProject = async (
  workspaceId: string,
  initiativeId: string,
  projectId: string
): Promise<ProjectRead> => {
  const response = await apiClient.put<ProjectRead>(
    initiativeProjectPath(workspaceId, initiativeId, projectId)
  );
  return response.data;
};

/** Takes a project out of an initiative; the project is kept. */
export const removeInitiativeProject = async (
  workspaceId: string,
  initiativeId: string,
  projectId: string
): Promise<ProjectRead> => {
  const response = await apiClient.delete<ProjectRead>(
    initiativeProjectPath(workspaceId, initiativeId, projectId)
  );
  return response.data;
};

/** Lists one initiative's updates, newest first, a cursor page at a time. */
export const listInitiativeUpdates = async (
  workspaceId: string,
  initiativeId: string,
  query: ProjectUpdateListQuery = {},
  signal?: AbortSignal
): Promise<InitiativeUpdateListRead> => {
  const response = await apiClient.get<InitiativeUpdateListRead>(
    initiativeUpdatesPath(workspaceId, initiativeId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    updates: Array.isArray(body?.updates) ? body.updates : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** Posts an update on an initiative, which sets the initiative's health. */
export const createInitiativeUpdate = async (
  workspaceId: string,
  initiativeId: string,
  body: ProjectUpdateCreate
): Promise<InitiativeUpdateRead> => {
  const response = await apiClient.post<InitiativeUpdateRead>(
    initiativeUpdatesPath(workspaceId, initiativeId),
    body
  );
  return response.data;
};

/** Edits an initiative update's body or health. */
export const updateInitiativeUpdate = async (
  workspaceId: string,
  initiativeId: string,
  updateId: string,
  body: ProjectUpdateEdit
): Promise<InitiativeUpdateRead> => {
  const response = await apiClient.patch<InitiativeUpdateRead>(
    initiativeUpdatePath(workspaceId, initiativeId, updateId),
    body
  );
  return response.data;
};

/** Deletes an initiative update. */
export const deleteInitiativeUpdate = async (
  workspaceId: string,
  initiativeId: string,
  updateId: string
): Promise<void> => {
  await apiClient.delete<void>(
    initiativeUpdatePath(workspaceId, initiativeId, updateId)
  );
};
