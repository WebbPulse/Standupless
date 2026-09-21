/**
 * The integrations contract the frontend depends on: the install URL fetched
 * rather than held, a missing installation read as null without swallowing a
 * real authorization failure, the repository pin sent as an explicit null to
 * clear it, the transitions and webhook routes, and the issue links page shape.
 * Each is pinned because a wrong path, verb or parameter name type-checks
 * identically and fails only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTransition,
  createWebhook,
  deleteInstallation,
  deleteTransition,
  deleteWebhook,
  getInstallUrl,
  getInstallation,
  installUrlPath,
  installationPath,
  issueLinksPath,
  linkRepository,
  listIssueLinks,
  listRepositories,
  listTransitions,
  listWebhooks,
  readInstallation,
  repositoriesPath,
  repositoryPath,
  rotateWebhookSecret,
  transitionPath,
  transitionsPath,
  updateTransition,
  updateWebhook,
  webhookPath,
  webhookRotatePath,
  webhooksPath,
} from './integrations';
import type {
  GithubInstallationRead,
  GithubIssueLinkRead,
  GithubRepositoryRead,
  TransitionRead,
  WebhookEndpointRead,
} from '../types/Api';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

/**
 * A status carrying failure, standing in for the shared client's `ApiError`
 * without importing the real one, since the module under test sees the mock.
 */
class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null
  ) {
    super(`status ${status}`);
  }
}

vi.mock('../lib/errors', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/errors')>('../lib/errors');
  return {
    ...actual,
    errorCode: (error: unknown) =>
      error instanceof FakeApiError ? error.code : null,
  };
});

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
  isApiErrorWithStatus: (error: unknown) => error instanceof FakeApiError,
}));

const WS = 'ws-mine';
const TEAM = 'proj-1';

/** One installation in exactly the shape the backend serialises. */
const installation: GithubInstallationRead = {
  installation_id: '44551122',
  account_login: 'WebbPulse',
  account_type: 'Organization',
  repository_selection: 'selected',
  html_url:
    'https://github.com/organizations/WebbPulse/settings/installations/44551122',
  installed_by: 'user-1',
  installed_at: '2026-09-18T00:00:00Z',
  repository_count: 2,
};

/** One repository in exactly the shape the backend serialises. */
const repository: GithubRepositoryRead = {
  repository_id: '9001',
  full_name: 'WebbPulse/standupless',
  name: 'standupless',
  private: false,
  default_branch: 'main',
  team_id: null,
  linked_at: '2026-09-18T00:00:00Z',
};

/** One pull request link in exactly the shape the backend serialises. */
const link: GithubIssueLinkRead = {
  link_id: 'PR_node#iss-1',
  issue_id: 'iss-1',
  issue_key: 'ENG-1',
  repository_full_name: 'WebbPulse/standupless',
  pr_number: 7,
  pr_title: 'Boot the engine',
  pr_url: 'https://github.com/WebbPulse/standupless/pull/7',
  pr_state: 'open',
  author_login: 'someone',
  closes_issue: true,
  applied_status_id: 'st-2',
  linked_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** One endpoint in exactly the shape a read returns, without a secret. */
const endpoint: WebhookEndpointRead = {
  webhook_id: 'wh-1',
  url: 'https://example.test/hook',
  events: ['issue.created'],
  description: null,
  active: true,
  secret_hint: 'ab12',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  last_status: null,
  last_delivery_at: null,
};

/** One transition rule in exactly the shape the backend serialises. */
const transition: TransitionRead = {
  transition_id: 'tr-1',
  team_id: TEAM,
  trigger: 'pr_merged',
  status_id: 'st-3',
  is_default: false,
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('route paths', () => {
  it('builds every integrations path under the workspace prefix', () => {
    expect(installUrlPath(WS)).toBe('/workspaces/ws-mine/github/install-url');
    expect(installationPath(WS)).toBe(
      '/workspaces/ws-mine/github/installation'
    );
    expect(repositoriesPath(WS)).toBe(
      '/workspaces/ws-mine/github/repositories'
    );
    expect(repositoryPath(WS, '9001')).toBe(
      '/workspaces/ws-mine/github/repositories/9001'
    );
    expect(issueLinksPath(WS, 'iss-1')).toBe(
      '/workspaces/ws-mine/issues/iss-1/github-links'
    );
    expect(transitionsPath(WS, TEAM)).toBe(
      '/workspaces/ws-mine/teams/proj-1/github-transitions'
    );
    expect(transitionPath(WS, TEAM, 'tr-1')).toBe(
      '/workspaces/ws-mine/teams/proj-1/github-transitions/tr-1'
    );
    expect(webhooksPath(WS)).toBe('/workspaces/ws-mine/webhooks');
    expect(webhookPath(WS, 'wh-1')).toBe('/workspaces/ws-mine/webhooks/wh-1');
    expect(webhookRotatePath(WS, 'wh-1')).toBe(
      '/workspaces/ws-mine/webhooks/wh-1/rotate'
    );
  });
});

describe('the install flow', () => {
  it('fetches the install url when it is asked for', async () => {
    get.mockResolvedValue({
      data: {
        url: 'https://github.com/apps/x/installations/new?state=s',
        expires_at: 'z',
      },
    });
    const result = await getInstallUrl(WS);
    expect(get).toHaveBeenCalledWith(installUrlPath(WS), undefined);
    expect(result.url).toContain('state=');
  });

  it('reads the installation when there is one', async () => {
    get.mockResolvedValue({ data: installation });
    await expect(getInstallation(WS)).resolves.toEqual(installation);
  });

  it('reads a missing installation as null rather than failing', async () => {
    get.mockRejectedValue(new FakeApiError(404));
    await expect(getInstallation(WS)).resolves.toBeNull();
  });

  it('settles a missing installation rather than leaving it a failure', async () => {
    get.mockRejectedValue(new FakeApiError(404));
    await expect(readInstallation(WS)).resolves.toEqual({
      status: 'not_installed',
    });
  });

  it('tells an unconfigured environment apart from a missing installation', async () => {
    get.mockRejectedValue(new FakeApiError(503, 'NOT_CONFIGURED'));
    await expect(readInstallation(WS)).resolves.toEqual({
      status: 'not_configured',
    });
  });

  it('still throws a 503 that is not the app being unconfigured', async () => {
    get.mockRejectedValue(new FakeApiError(503));
    await expect(readInstallation(WS)).rejects.toBeInstanceOf(FakeApiError);
  });

  it('reports an installation it did read', async () => {
    get.mockResolvedValue({ data: installation });
    await expect(readInstallation(WS)).resolves.toEqual({
      status: 'installed',
      installation,
    });
  });

  it('still throws when the caller may not look at the workspace', async () => {
    get.mockRejectedValue(new FakeApiError(403));
    await expect(getInstallation(WS)).rejects.toBeInstanceOf(FakeApiError);
  });

  it('rethrows a failure the client did not recognise', async () => {
    get.mockRejectedValue(new Error('network down'));
    await expect(getInstallation(WS)).rejects.toThrow('network down');
  });

  it('forgets the installation on this side', async () => {
    del.mockResolvedValue({ data: null });
    await deleteInstallation(WS);
    expect(del).toHaveBeenCalledWith(installationPath(WS), undefined);
  });
});

describe('repositories', () => {
  it('lists them and tolerates a body that is not an array', async () => {
    get.mockResolvedValue({ data: [repository] });
    await expect(listRepositories(WS)).resolves.toEqual([repository]);
    get.mockResolvedValue({ data: null });
    await expect(listRepositories(WS)).resolves.toEqual([]);
  });

  it('sends an explicit null to unpin a repository', async () => {
    patch.mockResolvedValue({ data: repository });
    await linkRepository(WS, '9001', null);
    expect(patch).toHaveBeenCalledWith(
      repositoryPath(WS, '9001'),
      { team_id: null },
      undefined
    );
  });

  it('sends the team id to pin a repository', async () => {
    patch.mockResolvedValue({ data: { ...repository, team_id: TEAM } });
    await linkRepository(WS, '9001', TEAM);
    expect(patch).toHaveBeenCalledWith(
      repositoryPath(WS, '9001'),
      { team_id: TEAM },
      undefined
    );
  });
});

describe('issue links', () => {
  it('returns the page and its cursor', async () => {
    get.mockResolvedValue({ data: { items: [link], next_cursor: 'c2' } });
    const page = await listIssueLinks(WS, 'iss-1', { limit: 10 });
    expect(get).toHaveBeenCalledWith(issueLinksPath(WS, 'iss-1'), {
      query: { limit: 10 },
    });
    expect(page.items).toEqual([link]);
    expect(page.next_cursor).toBe('c2');
  });

  it('reads an empty page when the body carries no items', async () => {
    get.mockResolvedValue({ data: {} });
    const page = await listIssueLinks(WS, 'iss-1');
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });
});

describe('transition rules', () => {
  it('lists, creates, updates and deletes a rule', async () => {
    get.mockResolvedValue({ data: [transition] });
    await expect(listTransitions(WS, TEAM)).resolves.toEqual([transition]);

    post.mockResolvedValue({ data: transition });
    await createTransition(WS, TEAM, {
      trigger: 'pr_merged',
      status_id: 'st-3',
    });
    expect(post).toHaveBeenCalledWith(
      transitionsPath(WS, TEAM),
      { trigger: 'pr_merged', status_id: 'st-3' },
      undefined
    );

    patch.mockResolvedValue({ data: transition });
    await updateTransition(WS, TEAM, 'tr-1', { status_id: null });
    expect(patch).toHaveBeenCalledWith(
      transitionPath(WS, TEAM, 'tr-1'),
      { status_id: null },
      undefined
    );

    del.mockResolvedValue({ data: null });
    await deleteTransition(WS, TEAM, 'tr-1');
    expect(del).toHaveBeenCalledWith(
      transitionPath(WS, TEAM, 'tr-1'),
      undefined
    );
  });
});

describe('webhook endpoints', () => {
  it('lists endpoints without a secret', async () => {
    get.mockResolvedValue({ data: [endpoint] });
    const rows = await listWebhooks(WS);
    expect(rows[0]?.secret).toBeUndefined();
  });

  it('returns the secret the create call mints', async () => {
    post.mockResolvedValue({ data: { ...endpoint, secret: 'whsec_abc' } });
    const created = await createWebhook(WS, {
      url: 'https://example.test/hook',
    });
    expect(post).toHaveBeenCalledWith(
      webhooksPath(WS),
      { url: 'https://example.test/hook' },
      undefined
    );
    expect(created.secret).toBe('whsec_abc');
  });

  it('returns the secret a rotate mints', async () => {
    post.mockResolvedValue({ data: { ...endpoint, secret: 'whsec_next' } });
    const rotated = await rotateWebhookSecret(WS, 'wh-1');
    expect(post).toHaveBeenCalledWith(
      webhookRotatePath(WS, 'wh-1'),
      {},
      undefined
    );
    expect(rotated.secret).toBe('whsec_next');
  });

  it('updates and deletes an endpoint', async () => {
    patch.mockResolvedValue({ data: { ...endpoint, active: false } });
    await updateWebhook(WS, 'wh-1', { active: false });
    expect(patch).toHaveBeenCalledWith(
      webhookPath(WS, 'wh-1'),
      { active: false },
      undefined
    );

    del.mockResolvedValue({ data: null });
    await deleteWebhook(WS, 'wh-1');
    expect(del).toHaveBeenCalledWith(webhookPath(WS, 'wh-1'), undefined);
  });
});
