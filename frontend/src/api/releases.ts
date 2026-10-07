/**
 * The release routes: a team's release pipeline, its releases newest first,
 * the stages each one reached and the issues it carried, and the releases one
 * issue shipped in. A release is filed under its team, so every release route
 * names the team in its path.
 */

import apiClient from './client';
import type {
  IssueReleaseListRead,
  ReleaseCreate,
  ReleaseDetailRead,
  ReleaseListQuery,
  ReleaseListRead,
  ReleasePipelineRead,
  ReleasePipelineUpdate,
  ReleaseStageAdvance,
  ReleaseUpdate,
} from '../types/Api';

/** The route a team's release pipeline is read and replaced through. */
export const releasePipelinePath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/teams/${teamId}/release-pipeline`;

/** The route a team's releases are listed and created on. */
export const teamReleasesApiPath = (
  workspaceId: string,
  teamId: string
): string => `/workspaces/${workspaceId}/teams/${teamId}/releases`;

/** The route one release is read, edited and deleted through. */
export const releaseApiPath = (
  workspaceId: string,
  teamId: string,
  releaseId: string
): string => `${teamReleasesApiPath(workspaceId, teamId)}/${releaseId}`;

/** The route a release is advanced to a stage on. */
export const releaseStagesPath = (
  workspaceId: string,
  teamId: string,
  releaseId: string
): string => `${releaseApiPath(workspaceId, teamId, releaseId)}/stages`;

/** The route issues are added to a release on. */
export const releaseIssuesPath = (
  workspaceId: string,
  teamId: string,
  releaseId: string
): string => `${releaseApiPath(workspaceId, teamId, releaseId)}/issues`;

/** The route one issue is removed from a release through. */
export const releaseIssuePath = (
  workspaceId: string,
  teamId: string,
  releaseId: string,
  issueRef: string
): string =>
  `${releaseIssuesPath(workspaceId, teamId, releaseId)}/${encodeURIComponent(issueRef)}`;

/** The route the releases one issue shipped in are read from. */
export const issueReleasesPath = (
  workspaceId: string,
  issueId: string
): string => `/workspaces/${workspaceId}/issues/${issueId}/releases`;

type QueryBag = Record<string, string | number | boolean | undefined>;

const listOptions = (
  query: QueryBag,
  signal?: AbortSignal
): { query: QueryBag; signal?: AbortSignal } =>
  signal === undefined ? { query } : { query, signal };

const signalOptions = (signal?: AbortSignal): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal };

const withDetail = (body: ReleaseDetailRead): ReleaseDetailRead => ({
  ...body,
  stages: Array.isArray(body?.stages) ? body.stages : [],
  issues: Array.isArray(body?.issues) ? body.issues : [],
  notes: typeof body?.notes === 'string' ? body.notes : '',
  skipped_issues: Array.isArray(body?.skipped_issues)
    ? body.skipped_issues
    : [],
});

/**
 * Reads a team's release pipeline. A team that never configured one reads the
 * default stages with `configured` false.
 */
export const getReleasePipeline = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<ReleasePipelineRead> => {
  const response = await apiClient.get<ReleasePipelineRead>(
    releasePipelinePath(workspaceId, teamId),
    signalOptions(signal)
  );
  const body = response.data;
  return { ...body, stages: Array.isArray(body?.stages) ? body.stages : [] };
};

/**
 * Replaces a team's release pipeline with the stages given, in order. A stage
 * that keeps its `stage_id` keeps the releases that reached it. Team admins
 * only.
 */
export const updateReleasePipeline = async (
  workspaceId: string,
  teamId: string,
  body: ReleasePipelineUpdate
): Promise<ReleasePipelineRead> => {
  const response = await apiClient.put<ReleasePipelineRead>(
    releasePipelinePath(workspaceId, teamId),
    body
  );
  return response.data;
};

/** Lists one page of a team's releases, newest first. */
export const listReleases = async (
  workspaceId: string,
  teamId: string,
  query: ReleaseListQuery = {},
  signal?: AbortSignal
): Promise<ReleaseListRead> => {
  const response = await apiClient.get<ReleaseListRead>(
    teamReleasesApiPath(workspaceId, teamId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    releases: Array.isArray(body?.releases) ? body.releases : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Records a release. A release that already exists for the same sha is
 * advanced instead, so the result is always the release the write landed on.
 */
export const createRelease = async (
  workspaceId: string,
  teamId: string,
  body: ReleaseCreate
): Promise<ReleaseDetailRead> => {
  const response = await apiClient.post<ReleaseDetailRead>(
    teamReleasesApiPath(workspaceId, teamId),
    body
  );
  return withDetail(response.data);
};

/** Reads one release with its issues and notes. */
export const getRelease = async (
  workspaceId: string,
  teamId: string,
  releaseId: string,
  signal?: AbortSignal
): Promise<ReleaseDetailRead> => {
  const response = await apiClient.get<ReleaseDetailRead>(
    releaseApiPath(workspaceId, teamId, releaseId),
    signalOptions(signal)
  );
  return withDetail(response.data);
};

/** Edits a release's name, version, description or url; null clears one. */
export const updateRelease = async (
  workspaceId: string,
  teamId: string,
  releaseId: string,
  body: ReleaseUpdate
): Promise<ReleaseDetailRead> => {
  const response = await apiClient.patch<ReleaseDetailRead>(
    releaseApiPath(workspaceId, teamId, releaseId),
    body
  );
  return withDetail(response.data);
};

/** Deletes a release. Team admins only. */
export const deleteRelease = async (
  workspaceId: string,
  teamId: string,
  releaseId: string
): Promise<void> => {
  await apiClient.delete<void>(releaseApiPath(workspaceId, teamId, releaseId));
};

/** Marks a release reached a pipeline stage, named by id or name. */
export const advanceRelease = async (
  workspaceId: string,
  teamId: string,
  releaseId: string,
  body: ReleaseStageAdvance
): Promise<ReleaseDetailRead> => {
  const response = await apiClient.post<ReleaseDetailRead>(
    releaseStagesPath(workspaceId, teamId, releaseId),
    body
  );
  return withDetail(response.data);
};

/**
 * Adds issues to a release by key or id. References that match no issue of
 * the team come back in `skipped_issues`.
 */
export const addReleaseIssues = async (
  workspaceId: string,
  teamId: string,
  releaseId: string,
  issues: string[]
): Promise<ReleaseDetailRead> => {
  const response = await apiClient.post<ReleaseDetailRead>(
    releaseIssuesPath(workspaceId, teamId, releaseId),
    { issues }
  );
  return withDetail(response.data);
};

/** Removes one issue from a release, named by key or id. */
export const removeReleaseIssue = async (
  workspaceId: string,
  teamId: string,
  releaseId: string,
  issueRef: string
): Promise<ReleaseDetailRead> => {
  const response = await apiClient.delete<ReleaseDetailRead>(
    releaseIssuePath(workspaceId, teamId, releaseId, issueRef)
  );
  return withDetail(response.data);
};

/** Lists the releases one issue shipped in, newest first. */
export const listIssueReleases = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<IssueReleaseListRead> => {
  const response = await apiClient.get<IssueReleaseListRead>(
    issueReleasesPath(workspaceId, issueId),
    signalOptions(signal)
  );
  const body = response.data;
  return { releases: Array.isArray(body?.releases) ? body.releases : [] };
};
