/**
 * The issue routes: issues themselves, their children, their links and their
 * activity. Issues are workspace scoped rather than nested under a team, so
 * a link and the "my issues" read can cross teams without a second call.
 */

import apiClient from './client';
import type {
  ActivityListRead,
  ActivityRead,
  IssueCreate,
  IssueListQuery,
  IssueListRead,
  IssueRead,
  IssueUpdate,
  LinkCreate,
  LinkListRead,
  LinkRead,
} from '../types/Api';

/** The route a workspace's issues are read from. */
export const issuesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/issues`;

/** The route one issue is read from. */
export const issuePath = (workspaceId: string, issueId: string): string =>
  `${issuesPath(workspaceId)}/${issueId}`;

/** The route one issue is read from by its human key, such as `ENG-12`. */
export const issueByKeyPath = (workspaceId: string, key: string): string =>
  `${issuesPath(workspaceId)}/by-key/${encodeURIComponent(key)}`;

/** The route an issue's direct children are read from. */
export const issueChildrenPath = (
  workspaceId: string,
  issueId: string
): string => `${issuePath(workspaceId, issueId)}/children`;

/** The route an issue's links are read from. */
export const issueLinksPath = (workspaceId: string, issueId: string): string =>
  `${issuePath(workspaceId, issueId)}/links`;

/** The route an issue's activity is read from. */
export const issueActivityPath = (
  workspaceId: string,
  issueId: string
): string => `${issuePath(workspaceId, issueId)}/activity`;

/**
 * The literal the list route accepts in place of a user id, so a caller can
 * filter to itself without first reading who it is.
 */
export const ME = 'me';

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

const listOptions = (
  query: Record<string, string | number | undefined>,
  signal?: AbortSignal
): {
  query: Record<string, string | number | undefined>;
  signal?: AbortSignal;
} => (signal === undefined ? { query } : { query, signal });

const emptyIssuePage = (): IssueListRead => ({ issues: [], next_cursor: null });

const readIssuePage = (body: IssueListRead | undefined): IssueListRead => ({
  issues: Array.isArray(body?.issues) ? body.issues : [],
  next_cursor: body?.next_cursor ?? null,
});

/**
 * Lists issues, one cursor page at a time. Without `team_id` the server fans
 * out across every team the caller can see and merges by the sort key, which
 * is what makes a cross-team view one request rather than a loop.
 */
export const listIssues = async (
  workspaceId: string,
  query: IssueListQuery = {},
  signal?: AbortSignal
): Promise<IssueListRead> => {
  const response = await apiClient.get<IssueListRead>(
    issuesPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  return readIssuePage(response.data);
};

/** Creates an issue. The key comes from the team counter, never the caller. */
export const createIssue = async (
  workspaceId: string,
  body: IssueCreate
): Promise<IssueRead> => {
  const response = await apiClient.post<IssueRead>(
    issuesPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one issue by id. */
export const getIssue = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<IssueRead> => {
  const response = await apiClient.get<IssueRead>(
    issuePath(workspaceId, issueId),
    signalOptions(signal)
  );
  return response.data;
};

/** Reads one issue by its key, which the contract matches case insensitively. */
export const getIssueByKey = async (
  workspaceId: string,
  key: string,
  signal?: AbortSignal
): Promise<IssueRead> => {
  const response = await apiClient.get<IssueRead>(
    issueByKeyPath(workspaceId, key),
    signalOptions(signal)
  );
  return response.data;
};

/** Updates an issue. Each changed field becomes one activity row server side. */
export const updateIssue = async (
  workspaceId: string,
  issueId: string,
  body: IssueUpdate
): Promise<IssueRead> => {
  const response = await apiClient.patch<IssueRead>(
    issuePath(workspaceId, issueId),
    body
  );
  return response.data;
};

/** Deletes an issue. The server reparents its children rather than cascading. */
export const deleteIssue = async (
  workspaceId: string,
  issueId: string
): Promise<void> => {
  await apiClient.delete<void>(issuePath(workspaceId, issueId));
};

/** Lists an issue's direct children, which the route orders by creation. */
export const listChildren = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<IssueListRead> => {
  const response = await apiClient.get<IssueListRead>(
    issueChildrenPath(workspaceId, issueId),
    listOptions({ ...query }, signal)
  );
  return readIssuePage(response.data);
};

/** Lists an issue's links. The route already folds in the inverse direction. */
export const listLinks = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<LinkRead[]> => {
  const response = await apiClient.get<LinkListRead>(
    issueLinksPath(workspaceId, issueId),
    signalOptions(signal)
  );
  const body = response.data;
  return Array.isArray(body?.links) ? body.links : [];
};

/** Adds a link. The route is idempotent on the same pair and type. */
export const createLink = async (
  workspaceId: string,
  issueId: string,
  body: LinkCreate
): Promise<LinkRead> => {
  const response = await apiClient.post<LinkRead>(
    issueLinksPath(workspaceId, issueId),
    body
  );
  return response.data;
};

/** Removes a link, which drops the row on both issues. */
export const deleteLink = async (
  workspaceId: string,
  issueId: string,
  linkId: string
): Promise<void> => {
  await apiClient.delete<void>(
    `${issueLinksPath(workspaceId, issueId)}/${linkId}`
  );
};

/** Lists an issue's activity, newest first, one cursor page at a time. */
export const listActivity = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<ActivityListRead> => {
  const response = await apiClient.get<ActivityListRead>(
    issueActivityPath(workspaceId, issueId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    activity: Array.isArray(body?.activity) ? body.activity : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** An empty page, for a query that is disabled before its ids are known. */
export const emptyPage = emptyIssuePage;

/** An empty activity page, used the same way as {@link emptyPage}. */
export const emptyActivityPage = (): ActivityListRead => ({
  activity: [],
  next_cursor: null,
});

/** Appends a cursor page to the rows already held, keeping their order. */
export const appendIssues = (
  held: IssueRead[],
  page: IssueListRead
): IssueRead[] => {
  const seen = new Set(held.map((issue) => issue.id));
  return [...held, ...page.issues.filter((issue) => !seen.has(issue.id))];
};

/** Appends an activity page to the entries already held. */
export const appendActivity = (
  held: ActivityRead[],
  page: ActivityListRead
): ActivityRead[] => {
  const seen = new Set(held.map((entry) => entry.activity_id));
  return [
    ...held,
    ...page.activity.filter((entry) => !seen.has(entry.activity_id)),
  ];
};
