/**
 * The page GitHub sends a platform admin back to. It exchanges the code once,
 * shows only the App's slug and id, and lays out the manual finish: the
 * settings link, the logo download and the badge colour.
 */

import { render, screen } from '@testing-library/react';
import { ApiError } from '@webbpulse/api-client';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GithubAppConversionCreate,
  GithubAppCreatedRead,
} from '../../types/Api';
import GithubAppCreated from './GithubAppCreated';

const convertGithubApp =
  vi.fn<(body: GithubAppConversionCreate) => Promise<GithubAppCreatedRead>>();

vi.mock('../../api/admin', () => ({
  convertGithubApp: (body: GithubAppConversionCreate) => convertGithubApp(body),
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

const created: GithubAppCreatedRead = {
  id: 987654,
  slug: 'standupless-staging',
  settings_url:
    'https://github.com/organizations/WebbPulse/settings/apps/standupless-staging',
  logo_path: '/github-app-logo.png',
  badge_color: '#141518',
};

/** A refusal in the shape the shared client throws. */
const refusal = (status: number, errorCode: string | null = null) =>
  new ApiError({
    status,
    statusText: '',
    body:
      errorCode === null
        ? null
        : { success: false, error_code: errorCode, message: 'x' },
    url: '/api/admin/github-app/conversions',
    method: 'POST',
  });

const renderAt = (search: string) =>
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/admin/github-app/created${search}`]}>
        <GithubAppCreated />
      </MemoryRouter>
    </StrictMode>
  );

beforeEach(() => {
  convertGithubApp.mockReset();
});

describe('GithubAppCreated', () => {
  it('exchanges the code once and shows the slug, id and finishing steps', async () => {
    convertGithubApp.mockResolvedValue(created);
    renderAt('?code=abc&state=signed');

    const id = await screen.findByText('987654');
    const details = id.closest('dl');
    expect(details).toHaveTextContent('Slugstandupless-staging');
    expect(details).toHaveTextContent('App ID987654');
    expect(convertGithubApp).toHaveBeenCalledTimes(1);
    expect(convertGithubApp).toHaveBeenCalledWith({
      code: 'abc',
      state: 'signed',
    });

    expect(
      screen.getByRole('link', { name: "App's settings on GitHub" })
    ).toHaveAttribute('href', created.settings_url);
    expect(
      screen.getByRole('link', { name: 'Download the logo' })
    ).toHaveAttribute('href', '/github-app-logo.png');
    expect(screen.getByText('#141518')).toBeInTheDocument();
    expect(screen.getByText('github_app_slug')).toBeInTheDocument();
  });

  it('asks for nothing when GitHub sent no code', () => {
    renderAt('?state=signed');
    expect(screen.getByText(/missing the code/)).toBeInTheDocument();
    expect(convertGithubApp).not.toHaveBeenCalled();
  });

  it('says a used or expired state must be started again', async () => {
    convertGithubApp.mockRejectedValue(refusal(400, 'INVALID_STATE'));
    renderAt('?code=abc&state=used');
    expect(
      await screen.findByText(/expired or was already used/)
    ).toBeInTheDocument();
  });

  it('names a failed store by its code, since the server masks the message', async () => {
    convertGithubApp.mockRejectedValue(refusal(503, 'STORE_FAILED'));
    renderAt('?code=abc&state=signed');
    expect(
      await screen.findByText(/credentials could not be stored/)
    ).toBeInTheDocument();
  });

  it('renders not found for anyone who is not a platform admin', async () => {
    convertGithubApp.mockRejectedValue(refusal(404));
    renderAt('?code=abc&state=signed');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});
