/**
 * The account deletion contract: the routes each call spends and the plan's
 * tolerance of a malformed body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETION_PLAN_ROUTE,
  ACCOUNT_DELETION_ROUTE,
  deleteAccount,
  getAccountDeletionPlan,
} from './account';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
  },
}));

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('the account deletion routes', () => {
  it('reads the plan, answering empty lists for missing arrays', async () => {
    get.mockResolvedValue({
      data: { blocking: [{ id: 'w', name: 'W', slug: 'w' }] },
    });

    await expect(getAccountDeletionPlan()).resolves.toEqual({
      blocking: [{ id: 'w', name: 'W', slug: 'w' }],
      deleted_with_account: [],
      leaving: [],
    });
    expect(get).toHaveBeenCalledWith(ACCOUNT_DELETION_PLAN_ROUTE, undefined);
  });

  it('deletes with the typed address', async () => {
    post.mockResolvedValue({ status: 204, data: '' });

    await deleteAccount({ confirm_email: 'me@example.com' });

    expect(ACCOUNT_DELETION_ROUTE).toBe('/users/me/deletion');
    expect(post).toHaveBeenCalledWith(
      ACCOUNT_DELETION_ROUTE,
      { confirm_email: 'me@example.com' },
      undefined
    );
  });
});
