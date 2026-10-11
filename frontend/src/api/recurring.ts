/**
 * The recurring issue routes: a team's schedules that create an issue from
 * one of its templates, daily, weekly on chosen days or monthly. Any team
 * member keeps them; a patch with `paused` pauses or resumes one.
 */

import apiClient, { type RequestOptions } from './client';
import type {
  RecurringIssueCreate,
  RecurringIssueListRead,
  RecurringIssueRead,
  RecurringIssueUpdate,
} from '../types/Api';

/** The route a team's recurring issues are read from and added to. */
export const recurringPath = (workspaceId: string, teamId: string): string =>
  `/workspaces/${workspaceId}/teams/${teamId}/recurring-issues`;

/** Lists a team's recurring issues, oldest first, with its default timezone. */
export const listRecurringIssues = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<RecurringIssueListRead> => {
  const options: RequestOptions | undefined =
    signal === undefined ? undefined : { signal };
  const response = await apiClient.get<RecurringIssueListRead>(
    recurringPath(workspaceId, teamId),
    options
  );
  const body = response.data as RecurringIssueListRead | undefined;
  return {
    recurring_issues: Array.isArray(body?.recurring_issues)
      ? body.recurring_issues
      : [],
    default_timezone: body?.default_timezone ?? 'UTC',
  };
};

/** Schedules an issue from one of the team's templates. */
export const createRecurringIssue = async (
  workspaceId: string,
  teamId: string,
  body: RecurringIssueCreate
): Promise<RecurringIssueRead> => {
  const response = await apiClient.post<RecurringIssueRead>(
    recurringPath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Changes, pauses or resumes one recurring issue. */
export const updateRecurringIssue = async (
  workspaceId: string,
  teamId: string,
  recurringId: string,
  body: RecurringIssueUpdate
): Promise<RecurringIssueRead> => {
  const response = await apiClient.patch<RecurringIssueRead>(
    `${recurringPath(workspaceId, teamId)}/${recurringId}`,
    body
  );
  return response.data;
};

/** Deletes one recurring issue; the issues it already created stay. */
export const deleteRecurringIssue = async (
  workspaceId: string,
  teamId: string,
  recurringId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${recurringPath(workspaceId, teamId)}/${recurringId}`
  );
};
