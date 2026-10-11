/**
 * The Reviews route: the open pull requests waiting on the caller as a
 * reviewer, matched by their linked GitHub account and grouped by where each
 * one stands for them.
 */

import apiClient from './client';
import type { ReviewCountsRead, ReviewsRead } from '../types/Api';

/** The Reviews route for one workspace. */
export const reviewsRoute = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/reviews`;

const EMPTY_COUNTS: ReviewCountsRead = {
  needs_review: 0,
  changes_requested: 0,
  approved: 0,
};

/**
 * Reads the caller's Reviews list. A missing body or field falls back to an
 * empty list rather than breaking the page, and an absent `github_linked`
 * reads as linked so the page never asks someone to link twice.
 */
export const getReviews = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<ReviewsRead> => {
  const response = await apiClient.get<ReviewsRead>(
    reviewsRoute(workspaceId),
    signal === undefined ? undefined : { signal }
  );
  const body = response.data;
  return {
    github_linked: body?.github_linked ?? true,
    counts: { ...EMPTY_COUNTS, ...(body?.counts ?? {}) },
    items: Array.isArray(body?.items) ? body.items : [],
  };
};
