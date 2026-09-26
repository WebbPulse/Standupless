/**
 * The platform admin's GitHub App page. What matters is that a non-admin sees
 * the ordinary not found page, that an environment which already has an App or
 * cannot store one offers no button, and that Create posts the server's
 * manifest to GitHub as a form field rather than navigating with it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubAppManifestRead,
  GithubAppStatusRead,
} from '../../types/Api';
import GithubApp from './GithubApp';

const getGithubAppStatus = vi.fn<() => Promise<GithubAppStatusRead>>();
const startGithubApp = vi.fn<() => Promise<GithubAppManifestRead>>();

vi.mock('../../api/admin', () => ({
  getGithubAppStatus: () => getGithubAppStatus(),
  startGithubApp: () => startGithubApp(),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

/** A refusal in the shape the shared client throws. */
const refusal = (status: number, errorCode: string | null = null) =>
  new ApiError({
    status,
    statusText: '',
    body:
      errorCode === null
        ? null
        : { success: false, error_code: errorCode, message: 'x' },
    url: '/api/admin/github-app',
    method: 'GET',
  });

/** The status for an environment with an empty app secret. */
const empty: GithubAppStatusRead = {
  configured: false,
  secret_available: true,
  organization: 'WebbPulse',
  app_name: 'Standupless (staging)',
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <GithubApp />
    </MemoryRouter>
  );

const submit = vi.fn<() => void>();

beforeEach(() => {
  getGithubAppStatus.mockReset();
  startGithubApp.mockReset();
  submit.mockReset();
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(submit);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GithubApp', () => {
  it('renders not found for anyone who is not a platform admin', async () => {
    getGithubAppStatus.mockRejectedValue(refusal(404));
    renderPage();
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create GitHub App' })
    ).not.toBeInTheDocument();
  });

  it('offers no button once the environment has an App', async () => {
    getGithubAppStatus.mockResolvedValue({ ...empty, configured: true });
    renderPage();
    expect(
      await screen.findByText(/already has a GitHub App/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create GitHub App' })
    ).not.toBeInTheDocument();
  });

  it('offers no button without an app secret', async () => {
    getGithubAppStatus.mockResolvedValue({ ...empty, secret_available: false });
    renderPage();
    expect(await screen.findByText(/no app secret/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create GitHub App' })
    ).not.toBeInTheDocument();
  });

  it('posts the manifest to GitHub as a form field', async () => {
    getGithubAppStatus.mockResolvedValue(empty);
    const manifest = { name: 'Standupless (staging)', public: true };
    const postUrl =
      'https://github.com/organizations/WebbPulse/settings/apps/new?state=signed';
    startGithubApp.mockResolvedValue({
      manifest,
      post_url: postUrl,
      expires_at: '2026-09-26T00:10:00Z',
    });
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Create GitHub App' })
    );

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1);
    });
    const form = screen.getByTestId('manifest-form');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('action', postUrl);
    const field = form.querySelector('input[name="manifest"]');
    expect(field).not.toBeNull();
    expect(JSON.parse((field as HTMLInputElement).value)).toEqual(manifest);
  });

  it('says why a start was refused and submits nothing', async () => {
    getGithubAppStatus.mockResolvedValue(empty);
    startGithubApp.mockRejectedValue(refusal(409, 'ALREADY_CONFIGURED'));
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Create GitHub App' })
    );

    expect(
      await screen.findByText(/Remove its keys from the app secret/)
    ).toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });
});
