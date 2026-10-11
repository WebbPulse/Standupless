/**
 * The Reviews contract the page and the sidebar badge depend on: the route
 * under the workspace, and a body whose missing fields fall back rather than
 * break the list.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getReviews, reviewsRoute } from './reviews';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
  },
}));

beforeEach(() => {
  get.mockReset();
});

describe('getReviews', () => {
  it('reads the workspace reviews route and passes the body through', async () => {
    const body = {
      github_linked: true,
      counts: { needs_review: 1, changes_requested: 0, approved: 0 },
      items: [
        {
          repository_id: '1',
          repository_full_name: 'acme/api',
          number: 7,
          title: 'Refactor the parser',
          url: 'https://github.com/acme/api/pull/7',
          author_login: 'olive',
          state: 'open',
          group: 'needs_review',
          review_state: 'pending',
          ci_state: 'success',
          created_at: null,
          updated_at: null,
          issues: [],
        },
      ],
    };
    get.mockResolvedValue({ data: body });

    const found = await getReviews('ws-1');

    expect(reviewsRoute('ws-1')).toBe('/workspaces/ws-1/reviews');
    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/reviews', undefined);
    expect(found).toEqual(body);
  });

  it('falls back to an empty list when the body is missing', async () => {
    get.mockResolvedValue({ data: undefined });

    expect(await getReviews('ws-1')).toEqual({
      github_linked: true,
      counts: { needs_review: 0, changes_requested: 0, approved: 0 },
      items: [],
    });
  });
});
