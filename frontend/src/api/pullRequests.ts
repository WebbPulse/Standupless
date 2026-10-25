/**
 * The linked pull request search behind the `#` reference picker and the pull
 * request chip. It answers only pull requests linked to issues the caller can
 * see, matched by title, `owner/repo#number` or a bare number.
 */

import apiClient from './client';
import type { PullRequestHitRead, PullRequestSearchRead } from '../types/Api';

/** The linked pull request search route for one workspace. */
export const pullRequestSearchRoute = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/github/pull-requests`;

/**
 * Searches the workspace's linked pull requests. A missing body or field
 * reads as no pull requests rather than breaking the picker.
 */
export const searchPullRequests = async (
  workspaceId: string,
  q: string,
  params: { limit?: number } = {},
  signal?: AbortSignal
): Promise<PullRequestHitRead[]> => {
  const response = await apiClient.get<PullRequestSearchRead>(
    pullRequestSearchRoute(workspaceId),
    {
      query: { q, ...params },
      ...(signal === undefined ? {} : { signal }),
    }
  );
  const hits = response.data?.pull_requests;
  return Array.isArray(hits) ? hits : [];
};
