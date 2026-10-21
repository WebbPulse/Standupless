/**
 * The profile contract: the route the save spends and the body it sends.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROFILE_ROUTE, updateProfile } from './profile';

const patch =
  vi.fn<(path: string, body?: unknown) => Promise<{ data: unknown }>>();

vi.mock('./client', () => ({
  default: {
    patch: (path: string, body?: unknown) => patch(path, body),
  },
}));

beforeEach(() => {
  patch.mockReset();
});

describe('updateProfile', () => {
  it('patches the profile route and answers the stored user', async () => {
    patch.mockResolvedValue({ data: { id: 'u-1', display_name: 'ada' } });

    await expect(
      updateProfile({ full_name: 'Ada Lovelace', display_name: 'ada' })
    ).resolves.toEqual({ id: 'u-1', display_name: 'ada' });
    expect(PROFILE_ROUTE).toBe('/users/me/profile');
    expect(patch).toHaveBeenCalledWith('/users/me/profile', {
      full_name: 'Ada Lovelace',
      display_name: 'ada',
    });
  });
});
