/**
 * The admin contract the GitHub App pages depend on: the paths, verbs and the
 * conversion body, pinned because a wrong one type-checks identically and fails
 * only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertGithubApp,
  getGithubAppStatus,
  githubAppConversionsPath,
  githubAppManifestPath,
  githubAppPath,
  startGithubApp,
} from './admin';

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

describe('admin api', () => {
  it('names the routes under /admin/github-app', () => {
    expect(githubAppPath).toBe('/admin/github-app');
    expect(githubAppManifestPath).toBe('/admin/github-app/manifest');
    expect(githubAppConversionsPath).toBe('/admin/github-app/conversions');
  });

  it('reads the status with a GET', async () => {
    const status = {
      configured: false,
      secret_available: true,
      organization: 'WebbPulse',
      app_name: 'Standupless (staging)',
    };
    get.mockResolvedValue({ data: status });
    await expect(getGithubAppStatus()).resolves.toEqual(status);
    expect(get).toHaveBeenCalledWith('/admin/github-app', undefined);
  });

  it('starts a creation with a bodiless POST', async () => {
    const start = {
      manifest: { name: 'Standupless' },
      post_url:
        'https://github.com/organizations/WebbPulse/settings/apps/new?state=s',
      expires_at: '2026-09-26T00:10:00Z',
    };
    post.mockResolvedValue({ data: start });
    await expect(startGithubApp()).resolves.toEqual(start);
    expect(post).toHaveBeenCalledWith(
      '/admin/github-app/manifest',
      undefined,
      undefined
    );
  });

  it('posts the code and state to the conversions route', async () => {
    const created = {
      id: 1,
      slug: 'standupless-staging',
      settings_url:
        'https://github.com/organizations/WebbPulse/settings/apps/standupless-staging',
      logo_path: '/github-app-logo.png',
      badge_color: '#141518',
    };
    post.mockResolvedValue({ data: created });
    await expect(convertGithubApp({ code: 'c', state: 's' })).resolves.toEqual(
      created
    );
    expect(post).toHaveBeenCalledWith(
      '/admin/github-app/conversions',
      { code: 'c', state: 's' },
      undefined
    );
  });
});
