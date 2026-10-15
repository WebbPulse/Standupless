/**
 * The loop both label merge calls share. A merge on a large team or workspace
 * can run out of time inside one request, answer `complete: false`, and resume
 * on the next call with the same target, so the client calls until it is done.
 */

import type { LabelMergeRead } from '../types/Api';

/** The most calls one merge makes before giving up on finishing it. */
export const MERGE_MAX_CALLS = 50;

/** Runs `call` until the merge it makes answers complete, or the calls run out. */
export const untilMergeComplete = async (
  call: () => Promise<LabelMergeRead>,
  remaining: number = MERGE_MAX_CALLS
): Promise<LabelMergeRead> => {
  const result = await call();
  if (result.complete || remaining <= 1) return result;
  return untilMergeComplete(call, remaining - 1);
};
