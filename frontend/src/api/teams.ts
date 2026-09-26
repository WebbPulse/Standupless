/**
 * The team routes: teams, their members, their statuses and their labels.
 * Every path is workspace scoped, because the contract never exposes a team
 * outside its tenant.
 */

import apiClient from './client';
import type {
  LabelCreate,
  LabelListRead,
  LabelRead,
  LabelUpdate,
  TeamCreate,
  TeamListRead,
  TeamMemberListRead,
  TeamMemberRead,
  TeamMemberUpdate,
  TeamRead,
  TeamUpdate,
  StatusCreate,
  StatusListRead,
  StatusRead,
  StatusUpdate,
} from '../types/Api';

/** The route a workspace's teams are read from. */
export const teamsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/teams`;

/** The route one team is read from. */
export const teamPath = (workspaceId: string, teamId: string): string =>
  `${teamsPath(workspaceId)}/${teamId}`;

/** The route a team's members are read from. */
export const teamMembersPath = (workspaceId: string, teamId: string): string =>
  `${teamPath(workspaceId, teamId)}/members`;

/** The route a team's statuses are read from. */
export const statusesPath = (workspaceId: string, teamId: string): string =>
  `${teamPath(workspaceId, teamId)}/statuses`;

/** The route a team's labels are read from. */
export const labelsPath = (workspaceId: string, teamId: string): string =>
  `${teamPath(workspaceId, teamId)}/labels`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists a workspace's teams. A guest sees only the ones they belong to. */
export const listTeams = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<TeamRead[]> => {
  const response = await apiClient.get<TeamListRead>(
    teamsPath(workspaceId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.teams) ? body.teams : [];
};

/** Creates a team. The creator becomes its admin and statuses are seeded. */
export const createTeam = async (
  workspaceId: string,
  body: TeamCreate
): Promise<TeamRead> => {
  const response = await apiClient.post<TeamRead>(teamsPath(workspaceId), body);
  return response.data;
};

/** Reads one team. */
export const getTeam = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TeamRead> => {
  const response = await apiClient.get<TeamRead>(
    teamPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/**
 * Updates a team's name, key, estimate scale or description. A new key
 * retires the old one, which keeps resolving issue keys.
 */
export const updateTeam = async (
  workspaceId: string,
  teamId: string,
  body: TeamUpdate
): Promise<TeamRead> => {
  const response = await apiClient.patch<TeamRead>(
    teamPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Deletes a team. Workspace owner or admin only. */
export const deleteTeam = async (
  workspaceId: string,
  teamId: string
): Promise<void> => {
  await apiClient.delete<void>(teamPath(workspaceId, teamId));
};

/** Lists a team's members. */
export const listTeamMembers = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TeamMemberRead[]> => {
  const response = await apiClient.get<TeamMemberListRead>(
    teamMembersPath(workspaceId, teamId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.members) ? body.members : [];
};

/**
 * Grants a team role. A PUT rather than a POST, because the contract makes
 * this an upsert on one user rather than an append to a collection.
 */
export const setTeamMember = async (
  workspaceId: string,
  teamId: string,
  userId: string,
  body: TeamMemberUpdate
): Promise<TeamMemberRead> => {
  const response = await apiClient.put<TeamMemberRead>(
    `${teamMembersPath(workspaceId, teamId)}/${userId}`,
    body
  );
  return response.data;
};

/** Removes one team member. */
export const removeTeamMember = async (
  workspaceId: string,
  teamId: string,
  userId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${teamMembersPath(workspaceId, teamId)}/${userId}`
  );
};

/** Joins a team as a member, or returns the membership already held. */
export const joinTeam = async (
  workspaceId: string,
  teamId: string
): Promise<TeamMemberRead> => {
  const response = await apiClient.post<TeamMemberRead>(
    `${teamPath(workspaceId, teamId)}/join`
  );
  return response.data;
};

/** Leaves a team. The API refuses the last admin with a 409. */
export const leaveTeam = async (
  workspaceId: string,
  teamId: string
): Promise<void> => {
  await apiClient.post<void>(`${teamPath(workspaceId, teamId)}/leave`);
};

/** Lists a team's statuses, which the API returns ordered by position. */
export const listStatuses = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<StatusRead[]> => {
  const response = await apiClient.get<StatusListRead>(
    statusesPath(workspaceId, teamId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.statuses) ? body.statuses : [];
};

/** Adds a status. */
export const createStatus = async (
  workspaceId: string,
  teamId: string,
  body: StatusCreate
): Promise<StatusRead> => {
  const response = await apiClient.post<StatusRead>(
    statusesPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Renames, recategorises or repositions a status. */
export const updateStatus = async (
  workspaceId: string,
  teamId: string,
  statusId: string,
  body: StatusUpdate
): Promise<StatusRead> => {
  const response = await apiClient.patch<StatusRead>(
    `${statusesPath(workspaceId, teamId)}/${statusId}`,
    body
  );
  return response.data;
};

/** Deletes a status. The API refuses the last one of its category with a 409. */
export const deleteStatus = async (
  workspaceId: string,
  teamId: string,
  statusId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${statusesPath(workspaceId, teamId)}/${statusId}`
  );
};

/** Lists a team's labels. */
export const listLabels = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<LabelRead[]> => {
  const response = await apiClient.get<LabelListRead>(
    labelsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.labels) ? body.labels : [];
};

/** Adds a label. */
export const createLabel = async (
  workspaceId: string,
  teamId: string,
  body: LabelCreate
): Promise<LabelRead> => {
  const response = await apiClient.post<LabelRead>(
    labelsPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Renames or recolours a label. */
export const updateLabel = async (
  workspaceId: string,
  teamId: string,
  labelId: string,
  body: LabelUpdate
): Promise<LabelRead> => {
  const response = await apiClient.patch<LabelRead>(
    `${labelsPath(workspaceId, teamId)}/${labelId}`,
    body
  );
  return response.data;
};

/** Deletes a label. */
export const deleteLabel = async (
  workspaceId: string,
  teamId: string,
  labelId: string
): Promise<void> => {
  await apiClient.delete<void>(`${labelsPath(workspaceId, teamId)}/${labelId}`);
};
