/**
 * The subscriber and preference routes the frontend depends on. Pinned because
 * a wrong path or verb type-checks identically and fails only against a live
 * backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  issueSubscribersPath,
  listSubscribers,
  subscribe,
  unsubscribe,
  updatePreferences,
} from './notifications';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const put =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    put: (path: string, body?: unknown, options?: unknown) =>
      put(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const EMPTY = { data: { subscribers: [], subscribed: false } };

beforeEach(() => {
  get.mockReset().mockResolvedValue(EMPTY);
  put.mockReset().mockResolvedValue(EMPTY);
  patch.mockReset().mockResolvedValue({ data: {} });
  del.mockReset().mockResolvedValue(EMPTY);
});

describe('the subscriber routes', () => {
  it('reads the subscribers under the issue', async () => {
    await listSubscribers('ws-1', 'iss-1');
    expect(issueSubscribersPath('ws-1', 'iss-1')).toBe(
      '/workspaces/ws-1/issues/iss-1/subscribers'
    );
    expect(get).toHaveBeenCalledWith(
      '/workspaces/ws-1/issues/iss-1/subscribers',
      undefined
    );
  });

  it('subscribes with a PUT and unsubscribes with a DELETE on me', async () => {
    await subscribe('ws-1', 'iss-1');
    await unsubscribe('ws-1', 'iss-1');
    expect(put).toHaveBeenCalledWith(
      '/workspaces/ws-1/issues/iss-1/subscribers/me',
      undefined,
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/issues/iss-1/subscribers/me',
      undefined
    );
  });
});

describe('the preference route', () => {
  it('sends only the switches that changed', async () => {
    await updatePreferences({
      notification_preferences: { commented: { email: false } },
    });
    expect(patch).toHaveBeenCalledWith(
      '/users/me/preferences',
      { notification_preferences: { commented: { email: false } } },
      undefined
    );
  });
});
