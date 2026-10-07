/**
 * The triage routes: a team's waiting issues, the per-team counts behind the
 * sidebar badges, the four ways an issue leaves triage, and the team's switch.
 */

import apiClient from './client';
import type {
  IssueListRead,
  IssueRead,
  TriageAccept,
  TriageDecline,
  TriageDuplicate,
  TriageSettingsRead,
  TriageSettingsUpdate,
  TriageSnooze,
  TriageSummaryRead,
} from '../types/Api';

/** The route a team's triage inbox is read from. */
export const triagePath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/issues/triage`;

/** The route one issue's triage actions hang off. */
const issueTriagePath = (workspaceId: string, issueId: string): string =>
  `/workspaces/${workspaceId}/issues/${issueId}/triage`;

/** The route a team's triage switch is read and changed at. */
export const triageSettingsPath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/teams/${teamId}/triage-settings`;

/** The query the triage list reads. */
export interface TriageListQuery {
  team_id: string;
  /** True lists only the snoozed issues instead of the waiting ones. */
  snoozed?: boolean;
  cursor?: string;
  limit?: number;
}

/** One page of a team's triage inbox, newest filed first. */
export const listTriage = async (
  workspaceId: string,
  query: TriageListQuery,
  signal?: AbortSignal
): Promise<IssueListRead> => {
  const response = await apiClient.get<IssueListRead>(triagePath(workspaceId), {
    query: { ...query },
    ...(signal === undefined ? {} : { signal }),
  });
  const body = response.data;
  return {
    issues: Array.isArray(body?.issues) ? body.issues : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** Each visible team with triage on and how many issues wait in it. */
export const getTriageSummary = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<TriageSummaryRead> => {
  const response = await apiClient.get<TriageSummaryRead>(
    `${triagePath(workspaceId)}/summary`,
    signal === undefined ? undefined : { signal }
  );
  return {
    teams: Array.isArray(response.data?.teams) ? response.data.teams : [],
  };
};

/** Accepts a waiting issue into the team. */
export const acceptTriage = async (
  workspaceId: string,
  issueId: string,
  body: TriageAccept = {}
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    `${issueTriagePath(workspaceId, issueId)}/accept`,
    body
  );
  return response.data;
};

/** Declines a waiting issue to the team's cancelled status. */
export const declineTriage = async (
  workspaceId: string,
  issueId: string,
  body: TriageDecline = {}
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    `${issueTriagePath(workspaceId, issueId)}/decline`,
    body
  );
  return response.data;
};

/** Closes a waiting issue as a duplicate of another. */
export const duplicateTriage = async (
  workspaceId: string,
  issueId: string,
  body: TriageDuplicate
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    `${issueTriagePath(workspaceId, issueId)}/duplicate`,
    body
  );
  return response.data;
};

/** Hides a waiting issue until a moment, or brings it back with null. */
export const snoozeTriage = async (
  workspaceId: string,
  issueId: string,
  body: TriageSnooze
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    `${issueTriagePath(workspaceId, issueId)}/snooze`,
    body
  );
  return response.data;
};

/** Reads a team's triage switch, off when never set. */
export const getTriageSettings = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TriageSettingsRead> => {
  const response = await apiClient.get<TriageSettingsRead>(
    triageSettingsPath(workspaceId, teamId),
    signal === undefined ? undefined : { signal }
  );
  return response.data;
};

/** Turns a team's triage inbox on or off. Team admin only. */
export const updateTriageSettings = async (
  workspaceId: string,
  teamId: string,
  body: TriageSettingsUpdate
): Promise<TriageSettingsRead> => {
  const response = await apiClient.patch<TriageSettingsRead>(
    triageSettingsPath(workspaceId, teamId),
    body
  );
  return response.data;
};
