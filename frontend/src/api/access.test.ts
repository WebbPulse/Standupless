/**
 * The M6 access contract the frontend depends on: the key and share link paths,
 * the listing query parameters, the plural keys the list bodies carry, and the
 * one property that cannot be seen by reading the types, which is that the
 * three `/shared` reads go through a client carrying no credential. A wrong
 * path, verb or parameter name type-checks identically and fails only against a
 * live backend, so each is pinned here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiKeyPath,
  apiKeysPath,
  createApiKey,
  createShareLink,
  getSharedIssue,
  getSharedTarget,
  listApiKeys,
  listSharedViewIssues,
  listShareLinks,
  revokeApiKey,
  revokeShareLink,
  shareLinkPath,
  shareLinksPath,
  sharedIssuePath,
  sharedTargetPath,
  sharedViewPath,
} from './access';
import type {
  ApiKeyCreatedRead,
  ApiKeyRead,
  ShareLinkCreatedRead,
  ShareLinkRead,
  SharedIssueRead,
  SharedTargetRead,
} from '../types/Api';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

/**
 * Hoisted, because `access.ts` constructs its anonymous client at import time,
 * which runs before an ordinary `const` in this file is initialised.
 */
const anon = vi.hoisted(() => ({
  get: vi.fn<(path: string, options?: unknown) => Promise<unknown>>(),
  created: vi.fn<(options: Record<string, unknown>) => void>(),
}));
const anonGet = anon.get;

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
  isApiErrorWithStatus: () => false,
}));

vi.mock('@webbpulse/api-client', () => ({
  createApiClient: (options: Record<string, unknown>) => {
    anon.created(options);
    return { get: (path: string, opts?: unknown) => anon.get(path, opts) };
  },
}));

/**
 * What `access.ts` constructed its anonymous client with, read at import time
 * because `beforeEach` clears the spy that recorded it.
 */
const anonymousClientOptions = anon.created.mock.calls.at(0)?.[0];

const WS = 'ws-1';
const TOKEN = 'shr_abcdef';

/** One key row in exactly the shape the backend serialises. */
const key: ApiKeyRead = {
  key_id: 'key-1',
  name: 'Shell',
  kind: 'user',
  prefix: 'wpk_abcd1234',
  scopes: ['issues:read'],
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
};

/** The mint response, the one body that carries a secret. */
const createdKey: ApiKeyCreatedRead = {
  ...key,
  secret: 'wpk_abcd1234plaintext',
};

/** One share link row in exactly the shape the backend serialises. */
const link: ShareLinkRead = {
  token_hash: 'hash-1',
  target_type: 'issue',
  target_id: 'iss-1',
  project_id: 'proj-1',
  title: 'Boot the engine',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: null,
  url: 'https://standupless.dev/shared',
};

/** The mint response, the one body that carries a token. */
const createdLink: ShareLinkCreatedRead = {
  ...link,
  token: TOKEN,
  url: `https://standupless.dev/shared/${TOKEN}`,
};

/** What a token resolves to. */
const target: SharedTargetRead = {
  target_type: 'issue',
  title: 'Boot the engine',
  workspace_name: 'Engineering',
  project_name: 'Platform',
  shared_at: '2026-09-18T00:00:00Z',
};

/** One shared issue in exactly the shape the backend serialises. */
const issue: SharedIssueRead = {
  issue_key: 'ENG-1',
  title: 'Boot the engine',
  body: 'It will not start.',
  status: { name: 'In progress', category: 'started', color: '#3b82f6' },
  priority: 'high',
  labels: [{ name: 'bug', color: '#ef4444' }],
  estimate: 3,
  start_date: null,
  due_date: null,
  assignee_name: 'Someone',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  comments: [
    {
      author_name: 'Someone',
      body: 'Looking at it.',
      created_at: '2026-09-18T01:00:00Z',
    },
  ],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  del.mockReset();
  anonGet.mockReset();
});

describe('the access route paths', () => {
  it('puts the key routes under the workspace prefix', () => {
    expect(apiKeysPath(WS)).toBe('/workspaces/ws-1/api-keys');
    expect(apiKeyPath(WS, 'key-1')).toBe('/workspaces/ws-1/api-keys/key-1');
  });

  it('names a share link revoke by its hash rather than by its token', () => {
    expect(shareLinksPath(WS)).toBe('/workspaces/ws-1/share-links');
    expect(shareLinkPath(WS, 'hash-1')).toBe(
      '/workspaces/ws-1/share-links/hash-1'
    );
  });

  it('puts the anonymous reads outside the workspace prefix', () => {
    expect(sharedTargetPath(TOKEN)).toBe('/shared/shr_abcdef');
    expect(sharedIssuePath(TOKEN)).toBe('/shared/shr_abcdef/issue');
    expect(sharedViewPath(TOKEN)).toBe('/shared/shr_abcdef/view');
  });

  it('escapes a token that would otherwise change the path', () => {
    expect(sharedTargetPath('a/b')).toBe('/shared/a%2Fb');
  });
});

describe('the API key calls', () => {
  it('reads the plural key and sends the listing scope', async () => {
    get.mockResolvedValue({ data: { api_keys: [key] } });

    await expect(listApiKeys(WS, { scope: 'workspace' })).resolves.toEqual([
      key,
    ]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/api-keys', {
      query: { scope: 'workspace' },
    });
  });

  it('answers an empty list when the body carries none', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listApiKeys(WS)).resolves.toEqual([]);
  });

  it('posts the mint body and hands back the secret', async () => {
    post.mockResolvedValue({ data: createdKey });

    const result = await createApiKey(WS, {
      name: 'Shell',
      scopes: ['issues:read'],
      kind: 'workspace',
      expires_in_days: 30,
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/api-keys',
      {
        name: 'Shell',
        scopes: ['issues:read'],
        kind: 'workspace',
        expires_in_days: 30,
      },
      undefined
    );
    expect(result.secret).toBe('wpk_abcd1234plaintext');
  });

  it('revokes a key by its id', async () => {
    del.mockResolvedValue({ data: undefined });

    await revokeApiKey(WS, 'key-1');

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/api-keys/key-1',
      undefined
    );
  });
});

describe('the share link calls', () => {
  it('reads the plural key and sends the target filter', async () => {
    get.mockResolvedValue({ data: { share_links: [link] } });

    await expect(
      listShareLinks(WS, { target_type: 'view', target_id: 'view-1' })
    ).resolves.toEqual([link]);
    expect(get).toHaveBeenCalledWith('/workspaces/ws-1/share-links', {
      query: { target_type: 'view', target_id: 'view-1' },
    });
  });

  it('posts the mint body and hands back the token carrying URL', async () => {
    post.mockResolvedValue({ data: createdLink });

    const result = await createShareLink(WS, {
      target_type: 'issue',
      target_id: 'iss-1',
    });

    expect(post).toHaveBeenCalledWith(
      '/workspaces/ws-1/share-links',
      { target_type: 'issue', target_id: 'iss-1' },
      undefined
    );
    expect(result.url).toContain(TOKEN);
  });

  it('revokes a link by its hash', async () => {
    del.mockResolvedValue({ data: undefined });

    await revokeShareLink(WS, 'hash-1');

    expect(del).toHaveBeenCalledWith(
      '/workspaces/ws-1/share-links/hash-1',
      undefined
    );
  });
});

describe('the anonymous share reads', () => {
  it('builds its client without an auth provider, so no bearer is sent', () => {
    expect(anonymousClientOptions).toBeDefined();
    expect(anonymousClientOptions).not.toHaveProperty('auth');
    expect(anonymousClientOptions).not.toHaveProperty('getAuthToken');
  });

  it('never touches the authenticated client', async () => {
    anonGet.mockResolvedValue({ data: target });

    await getSharedTarget(TOKEN);

    expect(anonGet).toHaveBeenCalledWith('/shared/shr_abcdef', undefined);
    expect(get).not.toHaveBeenCalled();
  });

  it('reads the one issue a token resolves to', async () => {
    anonGet.mockResolvedValue({ data: issue });

    await expect(getSharedIssue(TOKEN)).resolves.toEqual(issue);
    expect(anonGet).toHaveBeenCalledWith('/shared/shr_abcdef/issue', undefined);
  });

  it('pages a shared view and defaults a missing cursor to null', async () => {
    anonGet.mockResolvedValue({ data: { issues: [] } });

    await expect(
      listSharedViewIssues(TOKEN, { cursor: 'c1', limit: 50 })
    ).resolves.toEqual({ issues: [], next_cursor: null });
    expect(anonGet).toHaveBeenCalledWith('/shared/shr_abcdef/view', {
      query: { cursor: 'c1', limit: 50 },
    });
  });
});
