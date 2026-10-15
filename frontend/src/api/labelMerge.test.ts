/**
 * The label merge loop: a merge that runs out of time inside one request is
 * called again with the same target until it answers complete.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabelMergeRead } from '../types/Api';
import { runLabelMerge } from './labelMerge';

const post =
  vi.fn<(path: string, body: unknown) => Promise<{ data: LabelMergeRead }>>();

vi.mock('./client', () => ({
  default: { post: (path: string, body: unknown) => post(path, body) },
}));

/** One merge answer, finished or not. */
const answer = (
  complete: boolean,
  issues: number
): { data: LabelMergeRead } => ({
  data: {
    source_label_id: 'defect',
    source_name: 'Defect',
    target: { id: 'bug', name: 'Bug', color: '#e5484d' },
    issues_updated: issues,
    views_updated: 0,
    templates_updated: 0,
    complete,
  },
});

beforeEach(() => {
  post.mockReset();
});

describe('runLabelMerge', () => {
  it('calls again until the merge is complete', async () => {
    post
      .mockResolvedValueOnce(answer(false, 100))
      .mockResolvedValueOnce(answer(true, 140));
    const result = await runLabelMerge('/merge', 'bug');
    expect(result.issues_updated).toBe(140);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith('/merge', { target_label_id: 'bug' });
  });

  it('stops after its last call', async () => {
    post.mockResolvedValue(answer(false, 1));
    const result = await runLabelMerge('/merge', 'bug', 3);
    expect(result.complete).toBe(false);
    expect(post).toHaveBeenCalledTimes(3);
  });
});
