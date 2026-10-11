/**
 * The issue template routes: a team's templates, which include its parent
 * team's and the workspace's, the default its create dialog opens with, and
 * the workspace templates every team offers. A team's templates are kept by
 * its members, its default by a team admin and the workspace's by a workspace
 * admin.
 */

import apiClient, { type RequestOptions } from './client';
import type {
  TemplateCreate,
  TemplateListRead,
  TemplateRead,
  TemplateSettingsRead,
  TemplateSettingsUpdate,
  TemplateUpdate,
} from '../types/Api';

/** The route a team's templates are read from and added to. */
export const teamTemplatesPath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/teams/${teamId}/templates`;

/** The route a team's default template is read and set on. */
export const templateSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/teams/${teamId}/template-settings`;

/** The route the workspace's templates are read from and added to. */
export const workspaceTemplatesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/templates`;

/** The request options a read carries, only when there is a signal. */
const signalOptions = (signal?: AbortSignal): RequestOptions | undefined =>
  signal === undefined ? undefined : { signal };

/** A list answer with its arrays guaranteed, whatever the body held. */
const normalised = (body: TemplateListRead | undefined): TemplateListRead => ({
  templates: Array.isArray(body?.templates) ? body.templates : [],
  default_template_id: body?.default_template_id ?? null,
});

/**
 * Lists the templates a team offers, in picker order: its own, then its
 * parent team's, then the workspace's, with the default it opens with.
 */
export const listTeamTemplates = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TemplateListRead> => {
  const response = await apiClient.get<TemplateListRead>(
    teamTemplatesPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return normalised(response.data);
};

/** Adds a template to a team. */
export const createTeamTemplate = async (
  workspaceId: string,
  teamId: string,
  body: TemplateCreate
): Promise<TemplateRead> => {
  const response = await apiClient.post<TemplateRead>(
    teamTemplatesPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Changes, clears or moves one of a team's own templates. */
export const updateTeamTemplate = async (
  workspaceId: string,
  teamId: string,
  templateId: string,
  body: TemplateUpdate
): Promise<TemplateRead> => {
  const response = await apiClient.patch<TemplateRead>(
    `${teamTemplatesPath(workspaceId, teamId)}/${templateId}`,
    body
  );
  return response.data;
};

/** Deletes one of a team's own templates. */
export const deleteTeamTemplate = async (
  workspaceId: string,
  teamId: string,
  templateId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${teamTemplatesPath(workspaceId, teamId)}/${templateId}`
  );
};

/** Reads a team's saved default template and the one it falls back to. */
export const getTemplateSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TemplateSettingsRead> => {
  const response = await apiClient.get<TemplateSettingsRead>(
    templateSettingsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/** Sets or clears the template a team's create dialog opens with. */
export const updateTemplateSettings = async (
  workspaceId: string,
  teamId: string,
  body: TemplateSettingsUpdate
): Promise<TemplateSettingsRead> => {
  const response = await apiClient.patch<TemplateSettingsRead>(
    templateSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Lists the workspace's templates, which every team offers. */
export const listWorkspaceTemplates = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<TemplateListRead> => {
  const response = await apiClient.get<TemplateListRead>(
    workspaceTemplatesPath(workspaceId),
    signalOptions(signal)
  );
  return normalised(response.data);
};

/** Adds a workspace template. */
export const createWorkspaceTemplate = async (
  workspaceId: string,
  body: TemplateCreate
): Promise<TemplateRead> => {
  const response = await apiClient.post<TemplateRead>(
    workspaceTemplatesPath(workspaceId),
    body
  );
  return response.data;
};

/** Changes, clears or moves one workspace template. */
export const updateWorkspaceTemplate = async (
  workspaceId: string,
  templateId: string,
  body: TemplateUpdate
): Promise<TemplateRead> => {
  const response = await apiClient.patch<TemplateRead>(
    `${workspaceTemplatesPath(workspaceId)}/${templateId}`,
    body
  );
  return response.data;
};

/** Deletes one workspace template. */
export const deleteWorkspaceTemplate = async (
  workspaceId: string,
  templateId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${workspaceTemplatesPath(workspaceId)}/${templateId}`
  );
};
