/**
 * The team routes: teams, their members, their statuses and their labels.
 * Every path is workspace scoped, because the contract never exposes a team
 * outside its tenant.
 */

import apiClient, { type RequestOptions } from './client';
import type {
  ArchiveSettingsRead,
  ArchiveSettingsUpdate,
  CycleSettingsRead,
  CycleSettingsUpdate,
  LabelCreate,
  LabelListRead,
  LabelRead,
  LabelUpdate,
  OverrideUpdate,
  TeamCreate,
  TeamListRead,
  TeamMemberListRead,
  TeamMemberRead,
  TeamMemberUpdate,
  TeamOrderUpdate,
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

/** The route the caller's own sidebar team order is saved to. */
export const teamOrderPath = (workspaceId: string): string =>
  `${teamsPath(workspaceId)}/order`;

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

/** The route a team's automatic cycle schedule is read and changed on. */
export const cycleSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `${teamPath(workspaceId, teamId)}/cycle-settings`;

/** The route a team's auto-archive period is read and changed at. */
export const archiveSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `${teamPath(workspaceId, teamId)}/archive-settings`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** How a team's status or label list is read. */
export interface WorkflowListOptions {
  /** Also answers the inherited records the team hid, for its settings page. */
  includeHidden?: boolean;
}

/** The request options a workflow list read carries. */
const listOptions = (
  signal: AbortSignal | undefined,
  options: WorkflowListOptions
): RequestOptions | undefined => {
  if (options.includeHidden !== true) return signalOptions(signal);
  const query = { include_hidden: true };
  return signal === undefined ? { query } : { query, signal };
};

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

/**
 * Saves the caller's own sidebar team order for this workspace, which follows
 * them to every device. Answers the team list in the saved order.
 */
export const setTeamOrder = async (
  workspaceId: string,
  teamIds: string[]
): Promise<TeamRead[]> => {
  const body: TeamOrderUpdate = { team_ids: teamIds };
  const response = await apiClient.put<TeamListRead>(
    teamOrderPath(workspaceId),
    body
  );
  const data = response.data;
  return Array.isArray(data?.teams) ? data.teams : [];
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

/**
 * Lists a team's effective statuses ordered by position: its own and the
 * workspace's, with its overrides applied. Hidden inherited ones are left out
 * unless asked for.
 */
export const listStatuses = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal,
  options: WorkflowListOptions = {}
): Promise<StatusRead[]> => {
  const response = await apiClient.get<StatusListRead>(
    statusesPath(workspaceId, teamId),
    listOptions(signal, options)
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

/**
 * Lists a team's effective labels: its own and the workspace's, with its
 * overrides applied. Hidden inherited ones are left out unless asked for.
 */
export const listLabels = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal,
  options: WorkflowListOptions = {}
): Promise<LabelRead[]> => {
  const response = await apiClient.get<LabelListRead>(
    labelsPath(workspaceId, teamId),
    listOptions(signal, options)
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

/**
 * Hides, shows or locally renames an inherited workspace status in one team.
 * The API refuses a team status, and hiding the last visible one of a
 * category, with a 409.
 */
export const overrideStatus = async (
  workspaceId: string,
  teamId: string,
  statusId: string,
  body: OverrideUpdate
): Promise<StatusRead> => {
  const response = await apiClient.patch<StatusRead>(
    `${statusesPath(workspaceId, teamId)}/${statusId}/override`,
    body
  );
  return response.data;
};

/** Drops a team's override of an inherited status, showing it under its workspace name. */
export const resetStatusOverride = async (
  workspaceId: string,
  teamId: string,
  statusId: string
): Promise<StatusRead> => {
  const response = await apiClient.delete<StatusRead>(
    `${statusesPath(workspaceId, teamId)}/${statusId}/override`
  );
  return response.data;
};

/** Hides, shows or locally renames an inherited workspace label in one team. */
export const overrideLabel = async (
  workspaceId: string,
  teamId: string,
  labelId: string,
  body: OverrideUpdate
): Promise<LabelRead> => {
  const response = await apiClient.patch<LabelRead>(
    `${labelsPath(workspaceId, teamId)}/${labelId}/override`,
    body
  );
  return response.data;
};

/** Drops a team's override of an inherited label, showing it under its workspace name. */
export const resetLabelOverride = async (
  workspaceId: string,
  teamId: string,
  labelId: string
): Promise<LabelRead> => {
  const response = await apiClient.delete<LabelRead>(
    `${labelsPath(workspaceId, teamId)}/${labelId}/override`
  );
  return response.data;
};

/** Reads a team's automatic cycle schedule, or its defaults when never set. */
export const getCycleSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<CycleSettingsRead> => {
  const response = await apiClient.get<CycleSettingsRead>(
    cycleSettingsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/**
 * Changes a team's automatic cycle schedule. Team admin only. When the result
 * is enabled the server creates the current and upcoming cycles before it
 * answers.
 */
export const updateCycleSettings = async (
  workspaceId: string,
  teamId: string,
  body: CycleSettingsUpdate
): Promise<CycleSettingsRead> => {
  const response = await apiClient.patch<CycleSettingsRead>(
    cycleSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Reads a team's auto-archive period, or the six month default when never set. */
export const getArchiveSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<ArchiveSettingsRead> => {
  const response = await apiClient.get<ArchiveSettingsRead>(
    archiveSettingsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/** Changes a team's auto-archive period. Team admin only. */
export const updateArchiveSettings = async (
  workspaceId: string,
  teamId: string,
  body: ArchiveSettingsUpdate
): Promise<ArchiveSettingsRead> => {
  const response = await apiClient.patch<ArchiveSettingsRead>(
    archiveSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};
