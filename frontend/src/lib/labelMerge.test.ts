/**
 * The label merge loop: a merge that runs out of time inside one request is
 * called again until it answers complete.
 */

import { describe, expect, it, vi } from 'vitest';
import type { LabelMergeRead } from '../types/Api';
import { untilMergeComplete } from './labelMerge';

/** One merge answer, finished or not. */
const answer = (complete: boolean, issues: number): LabelMergeRead => ({
  source_label_id: 'defect',
  source_name: 'Defect',
  target: { id: 'bug', name: 'Bug', color: '#e5484d' },
  issues_updated: issues,
  views_updated: 0,
  templates_updated: 0,
  complete,
});

describe('untilMergeComplete', () => {
  it('calls again until the merge is complete', async () => {
    const call = vi
      .fn<() => Promise<LabelMergeRead>>()
      .mockResolvedValueOnce(answer(false, 100))
      .mockResolvedValueOnce(answer(true, 140));
    const result = await untilMergeComplete(call);
    expect(result.issues_updated).toBe(140);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('stops after its last call', async () => {
    const call = vi
      .fn<() => Promise<LabelMergeRead>>()
      .mockResolvedValue(answer(false, 1));
    const result = await untilMergeComplete(call, 3);
    expect(result.complete).toBe(false);
    expect(call).toHaveBeenCalledTimes(3);
  });
});
