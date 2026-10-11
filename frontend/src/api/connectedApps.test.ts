/**
 * The connected apps contract: the routes each call spends, that an id is
 * escaped into its path, and the list reads' tolerance of a malformed body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MY_CONNECTED_APPS_ROUTE,
  grantMyConnectedAppScopes,
  listMyConnectedApps,
  listWorkspaceConnectedApps,
  revokeMyConnectedApp,
  revokeWorkspaceConnectedApp,
} from './connectedApps';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post = vi.fn<(path: string, body?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    delete: (path: string, options?: unknown) => del(path, options),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

beforeEach(() => {
  get.mockReset();
  del.mockReset();
  del.mockResolvedValue({ data: null });
  post.mockReset();
});

describe('granting new permissions', () => {
  it('posts the approved scopes to the escaped client path', async () => {
    post.mockResolvedValue({ data: { client_id: 'a b' } });

    await expect(
      grantMyConnectedAppScopes('a b', ['releases:read'])
    ).resolves.toEqual({ client_id: 'a b' });
    expect(post).toHaveBeenCalledWith('/users/me/connected-apps/a%20b/scopes', {
      scopes: ['releases:read'],
    });
  });
});

describe('the connected apps routes', () => {
  it('lists the caller apps from the apps key', async () => {
    get.mockResolvedValue({ data: { apps: [{ client_id: 'c' }] } });

    await expect(listMyConnectedApps()).resolves.toEqual([{ client_id: 'c' }]);
    expect(MY_CONNECTED_APPS_ROUTE).toBe('/users/me/connected-apps');
    expect(get).toHaveBeenCalledWith(MY_CONNECTED_APPS_ROUTE, undefined);
  });

  it('answers an empty list for a malformed body', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listMyConnectedApps()).resolves.toEqual([]);
    await expect(listWorkspaceConnectedApps('ws-1')).resolves.toEqual([]);
    expect(get).toHaveBeenLastCalledWith(
      '/workspaces/ws-1/connected-apps',
      undefined
    );
  });

  it('revokes by an escaped client id', async () => {
    await revokeMyConnectedApp('mcp/a b');

    expect(del).toHaveBeenCalledWith(
      '/users/me/connected-apps/mcp%2Fa%20b',
      undefined
    );
  });

  it('revokes a member grant under the workspace', async () => {
    await revokeWorkspaceConnectedApp('ws-1', 'user-2', 'mcp_1');

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/connected-apps/user-2/mcp_1',
      undefined
    );
  });
});
