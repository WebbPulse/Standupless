/**
 * The team routes: teams, their members, their statuses and their labels.
 * Every path is workspace scoped, because the contract never exposes a team
 * outside its tenant.
 */

import type {
  PolledQueryContext,
  PolledResponse,
} from '@webbpulse/api-client/react';
import apiClient, { type RequestOptions } from './client';
import { untilMergeComplete } from '../lib/labelMerge';
import { conditionalGet, type ReadContext } from './conditional';
import type { IssueListSort } from './issues';
import type {
  CompletedWindow,
  ViewGroupHeader,
  ViewLayout,
  ViewVisibleProperty,
} from './views';
import type {
  ArchiveSettingsRead,
  ArchiveSettingsUpdate,
  AutoCloseSettingsRead,
  AutoCloseSettingsUpdate,
  ParentAutoCloseSettingsRead,
  ParentAutoCloseSettingsUpdate,
  CycleSettingsRead,
  CycleSettingsUpdate,
  LabelCreate,
  LabelListRead,
  LabelMergeRead,
  LabelRead,
  LabelUpdate,
  OverrideUpdate,
  SlaSettingsRead,
  SlaSettingsUpdate,
  TeamCreate,
  TeamListRead,
  TeamMemberListRead,
  TeamMemberRead,
  TeamMemberUpdate,
  TeamOrderUpdate,
  TeamRead,
  TeamUpdate,
  ProjectsDisplayPreference,
  StatusCreate,
  StatusListRead,
  StatusRead,
  StatusUpdate,
  ViewGroupBy,
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

/**
 * The display options one team page opens with. Each null field keeps the
 * page's built-in default, and a grouping of `none` means no grouping.
 */
export interface TeamDisplayOptions {
  layout?: ViewLayout | null;
  group_by?: ViewGroupBy | 'none' | null;
  sub_group_by?: ViewGroupBy | 'none' | null;
  ordering?: IssueListSort | null;
  ordering_reversed?: boolean | null;
  visible_properties?: ViewVisibleProperty[] | null;
  show_sub_issues?: boolean | null;
  completed_window?: CompletedWindow | null;
  show_empty_groups?: boolean | null;
  show_archived?: boolean | null;
  group_header?: ViewGroupHeader | null;
}

/**
 * What a team's list and board open with for every member until they change
 * the display themselves. A null page keeps the built-in default.
 */
export interface TeamDisplayDefaultsRead {
  team_id: string;
  list_display: TeamDisplayOptions | null;
  board_display: TeamDisplayOptions | null;
  /** The team's own projects page default, null when it set none. */
  projects_display?: ProjectsDisplayPreference | null;
  /** What the team's projects page opens with: the team default, else the workspace's, else the built-in. */
  effective_projects_display?: ProjectsDisplayPreference;
  updated_by: string | null;
  updated_at: string | null;
}

/** A change to a team's display defaults: a page given replaces it whole, null clears it. */
export interface TeamDisplayDefaultsUpdate {
  list_display?: TeamDisplayOptions | null;
  board_display?: TeamDisplayOptions | null;
  projects_display?: ProjectsDisplayPreference | null;
}

/** The workspace's own projects page default, as its display defaults route answers it. */
export interface WorkspaceDisplayDefaultsRead {
  /** Null when no admin set one. */
  projects_display: ProjectsDisplayPreference | null;
  /** What the workspace projects page opens with for someone who never arranged it. */
  effective_projects_display: ProjectsDisplayPreference;
  updated_by: string | null;
  updated_at: string | null;
}

/** The route the workspace's display defaults are read and changed at. */
export const workspaceDisplayDefaultsPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/display-defaults`;

/** The route a team's display defaults are read and changed at. */
export const displayDefaultsPath = (
  workspaceId: string,
  teamId: string
): string => `${teamPath(workspaceId, teamId)}/display-defaults`;

/** The route a team's auto-close setting is read and changed at. */
export const autoCloseSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `${teamPath(workspaceId, teamId)}/auto-close-settings`;

/** The route a team's parent and sub-issue auto-close settings are read and changed at. */
export const parentAutoCloseSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `${teamPath(workspaceId, teamId)}/parent-auto-close-settings`;

/** The route a team's auto-archive period is read and changed at. */
export const archiveSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `${teamPath(workspaceId, teamId)}/archive-settings`;

/** The route a team's SLA rules are read and changed at. */
export const slaSettingsPath = (workspaceId: string, teamId: string): string =>
  `${teamPath(workspaceId, teamId)}/sla-settings`;

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

/**
 * Lists a workspace's teams. A guest sees only the ones they belong to. Handed
 * a polled query's context, the read is conditional on the held ETag.
 */
export function listTeams(
  workspaceId: string,
  signal?: AbortSignal
): Promise<TeamRead[]>;
export function listTeams(
  workspaceId: string,
  context: PolledQueryContext
): Promise<PolledResponse<TeamRead[]>>;
export function listTeams(
  workspaceId: string,
  context?: ReadContext
): Promise<TeamRead[] | PolledResponse<TeamRead[]>> {
  return conditionalGet<TeamListRead, TeamRead[]>(
    teamsPath(workspaceId),
    signalOptions,
    context,
    (body) => (Array.isArray(body?.teams) ? body.teams : [])
  );
}

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

/**
 * Retires a team: it leaves the sidebar and the team pickers, and its work
 * turns read-only. Team admin only.
 */
export const retireTeam = async (
  workspaceId: string,
  teamId: string
): Promise<TeamRead> => {
  const response = await apiClient.post<TeamRead>(
    `${teamPath(workspaceId, teamId)}/retire`
  );
  return response.data;
};

/** Brings a retired team back so it takes changes again. Team admin only. */
export const unretireTeam = async (
  workspaceId: string,
  teamId: string
): Promise<TeamRead> => {
  const response = await apiClient.post<TeamRead>(
    `${teamPath(workspaceId, teamId)}/unretire`
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

/**
 * Lists a team's members. Handed a polled query's context, the read is
 * conditional on the held ETag.
 */
export function listTeamMembers(
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TeamMemberRead[]>;
export function listTeamMembers(
  workspaceId: string,
  teamId: string,
  context: PolledQueryContext
): Promise<PolledResponse<TeamMemberRead[]>>;
export function listTeamMembers(
  workspaceId: string,
  teamId: string,
  context?: ReadContext
): Promise<TeamMemberRead[] | PolledResponse<TeamMemberRead[]>> {
  return conditionalGet<TeamMemberListRead, TeamMemberRead[]>(
    teamMembersPath(workspaceId, teamId),
    signalOptions,
    context,
    (body) => (Array.isArray(body?.members) ? body.members : [])
  );
}

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
 * unless asked for. Handed a polled query's context, the read is conditional
 * on the held ETag.
 */
export function listStatuses(
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal,
  options?: WorkflowListOptions
): Promise<StatusRead[]>;
export function listStatuses(
  workspaceId: string,
  teamId: string,
  context: PolledQueryContext,
  options?: WorkflowListOptions
): Promise<PolledResponse<StatusRead[]>>;
export function listStatuses(
  workspaceId: string,
  teamId: string,
  context?: ReadContext,
  options: WorkflowListOptions = {}
): Promise<StatusRead[] | PolledResponse<StatusRead[]>> {
  return conditionalGet<StatusListRead, StatusRead[]>(
    statusesPath(workspaceId, teamId),
    (signal) => listOptions(signal, options),
    context,
    (body) => (Array.isArray(body?.statuses) ? body.statuses : [])
  );
}

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

/**
 * Deletes a status, moving its issues to `replacementStatusId`. The API refuses
 * the last one of its category, and one still holding issues when no
 * replacement is named, with a 409.
 */
export const deleteStatus = async (
  workspaceId: string,
  teamId: string,
  statusId: string,
  replacementStatusId?: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${statusesPath(workspaceId, teamId)}/${statusId}`,
    replacementStatusId === undefined
      ? undefined
      : { query: { replacement_status_id: replacementStatusId } }
  );
};

/**
 * Lists a team's effective labels: its own and the workspace's, with its
 * overrides applied. Hidden inherited ones are left out unless asked for.
 * Handed a polled query's context, the read is conditional on the held ETag.
 */
export function listLabels(
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal,
  options?: WorkflowListOptions
): Promise<LabelRead[]>;
export function listLabels(
  workspaceId: string,
  teamId: string,
  context: PolledQueryContext,
  options?: WorkflowListOptions
): Promise<PolledResponse<LabelRead[]>>;
export function listLabels(
  workspaceId: string,
  teamId: string,
  context?: ReadContext,
  options: WorkflowListOptions = {}
): Promise<LabelRead[] | PolledResponse<LabelRead[]>> {
  return conditionalGet<LabelListRead, LabelRead[]>(
    labelsPath(workspaceId, teamId),
    (signal) => listOptions(signal, options),
    context,
    (body) => (Array.isArray(body?.labels) ? body.labels : [])
  );
}

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

/** Folds one of a team's labels into another, every issue carrying it moving over. */
export const mergeLabel = (
  workspaceId: string,
  teamId: string,
  labelId: string,
  targetLabelId: string
): Promise<LabelMergeRead> =>
  untilMergeComplete(async () => {
    const response = await apiClient.post<LabelMergeRead>(
      `${labelsPath(workspaceId, teamId)}/${labelId}/merge`,
      { target_label_id: targetLabelId }
    );
    return response.data;
  });

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

/** Reads what a team's list and board open with, both null when never set. */
export const getDisplayDefaults = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TeamDisplayDefaultsRead> => {
  const response = await apiClient.get<TeamDisplayDefaultsRead>(
    displayDefaultsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/** Changes what a team's list or board opens with. Team admin only. */
export const updateDisplayDefaults = async (
  workspaceId: string,
  teamId: string,
  body: TeamDisplayDefaultsUpdate
): Promise<TeamDisplayDefaultsRead> => {
  const response = await apiClient.patch<TeamDisplayDefaultsRead>(
    displayDefaultsPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Reads what the workspace projects page opens with for someone who never arranged it. */
export const getWorkspaceDisplayDefaults = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<WorkspaceDisplayDefaultsRead> => {
  const response = await apiClient.get<WorkspaceDisplayDefaultsRead>(
    workspaceDisplayDefaultsPath(workspaceId),
    signalOptions(signal)
  );
  return response.data;
};

/** Sets or clears the workspace projects page default, null clearing it. Workspace admin only. */
export const updateWorkspaceDisplayDefaults = async (
  workspaceId: string,
  projectsDisplay: ProjectsDisplayPreference | null
): Promise<WorkspaceDisplayDefaultsRead> => {
  const response = await apiClient.patch<WorkspaceDisplayDefaultsRead>(
    workspaceDisplayDefaultsPath(workspaceId),
    { projects_display: projectsDisplay }
  );
  return response.data;
};

/** Reads a team's auto-close setting, off when never set. */
export const getAutoCloseSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<AutoCloseSettingsRead> => {
  const response = await apiClient.get<AutoCloseSettingsRead>(
    autoCloseSettingsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/** Changes a team's auto-close period or target status. Team admin only. */
export const updateAutoCloseSettings = async (
  workspaceId: string,
  teamId: string,
  body: AutoCloseSettingsUpdate
): Promise<AutoCloseSettingsRead> => {
  const response = await apiClient.patch<AutoCloseSettingsRead>(
    autoCloseSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Reads whether a team closes parents and sub-issues together, both off when never set. */
export const getParentAutoCloseSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<ParentAutoCloseSettingsRead> => {
  const response = await apiClient.get<ParentAutoCloseSettingsRead>(
    parentAutoCloseSettingsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/** Turns a team's parent or sub-issue auto-close on or off. Team admin only. */
export const updateParentAutoCloseSettings = async (
  workspaceId: string,
  teamId: string,
  body: ParentAutoCloseSettingsUpdate
): Promise<ParentAutoCloseSettingsRead> => {
  const response = await apiClient.patch<ParentAutoCloseSettingsRead>(
    parentAutoCloseSettingsPath(workspaceId, teamId),
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

/** Reads a team's SLA rules, or the off-by-default rules when never set. */
export const getSlaSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<SlaSettingsRead> => {
  const response = await apiClient.get<SlaSettingsRead>(
    slaSettingsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return response.data;
};

/** Changes a team's SLA rules. Team admin only. */
export const updateSlaSettings = async (
  workspaceId: string,
  teamId: string,
  body: SlaSettingsUpdate
): Promise<SlaSettingsRead> => {
  const response = await apiClient.patch<SlaSettingsRead>(
    slaSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};
