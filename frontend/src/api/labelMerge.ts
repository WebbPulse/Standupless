/**
 * The loop both label merge routes share. A merge on a large team or workspace
 * can run out of time inside one request, answer `complete: false`, and resume
 * on the next call with the same target, so the client calls until it is done.
 */

import apiClient from './client';
import type { LabelMergeRead } from '../types/Api';

/** The most calls one merge makes before giving up on finishing it. */
export const MERGE_MAX_CALLS = 50;

/**
 * Calls one merge route until the merge finishes. A large merge answers
 * `complete: false` when it runs out of time, and calling it again resumes it.
 */
export const runLabelMerge = async (
  path: string,
  targetLabelId: string,
  remaining: number = MERGE_MAX_CALLS
): Promise<LabelMergeRead> => {
  const response = await apiClient.post<LabelMergeRead>(path, {
    target_label_id: targetLabelId,
  });
  if (response.data.complete || remaining <= 1) return response.data;
  return runLabelMerge(path, targetLabelId, remaining - 1);
};
