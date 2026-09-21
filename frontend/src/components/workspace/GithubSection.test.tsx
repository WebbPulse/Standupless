/**
 * The GitHub settings section. Covers that a workspace with no installation is
 * offered the install rather than an empty repository list, that the install
 * URL is fetched at the moment the button is pressed rather than held from the
 * page load, and that pinning a repository to every team sends an explicit
 * null rather than an empty string.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationState } from '../../api/integrations';
import type {
  GithubInstallationRead,
  GithubRepositoryRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import GithubSection from './GithubSection';

const readInstallation = vi.fn<() => Promise<InstallationState>>();
const getInstallUrl =
  vi.fn<() => Promise<{ url: string; expires_at: string }>>();
const listRepositories = vi.fn<() => Promise<GithubRepositoryRead[]>>();
const deleteInstallation = vi.fn<() => Promise<void>>();
const linkRepository =
  vi.fn<(repositoryId: string, teamId: string | null) => Promise<unknown>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    readInstallation: () => readInstallation(),
    getInstallUrl: () => getInstallUrl(),
    listRepositories: () => listRepositories(),
    deleteInstallation: () => deleteInstallation(),
    linkRepository: (_w: string, repositoryId: string, teamId: string | null) =>
      linkRepository(repositoryId, teamId),
  };
});

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return { ...actual, listTeams: () => listTeams() };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** The workspace the section is rendered for. */
const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Engineering',
  slug: 'engineering',
  plan: 'free',
  created_at: '2026-09-18T00:00:00Z',
  role: 'admin',
};

/** One installation in the shape the contract answers with. */
const installation = (
  over: Partial<GithubInstallationRead> = {}
): GithubInstallationRead => ({
  installation_id: '44551122',
  account_login: 'WebbPulse',
  account_type: 'Organization',
  repository_selection: 'selected',
  html_url: 'https://github.com/settings/installations/44551122',
  installed_by: 'user-1',
  installed_at: '2026-09-18T00:00:00Z',
  repository_count: 1,
  ...over,
});

/** One repository in the shape the contract answers with. */
const repository = (
  over: Partial<GithubRepositoryRead> = {}
): GithubRepositoryRead => ({
  repository_id: '9001',
  full_name: 'WebbPulse/standupless',
  name: 'standupless',
  private: false,
  default_branch: 'main',
  team_id: 'proj-1',
  linked_at: '2026-09-18T00:00:00Z',
  ...over,
});

const assign = vi.fn();

beforeEach(() => {
  readInstallation.mockReset();
  getInstallUrl.mockReset();
  listRepositories.mockReset();
  deleteInstallation.mockReset();
  linkRepository.mockReset();
  listTeams.mockReset();
  assign.mockReset();
  readInstallation.mockResolvedValue({
    status: 'installed',
    installation: installation(),
  });
  getInstallUrl.mockResolvedValue({
    url: 'https://github.com/apps/standupless/installations/new?state=signed',
    expires_at: '2026-09-18T00:10:00Z',
  });
  listRepositories.mockResolvedValue([repository()]);
  deleteInstallation.mockResolvedValue(undefined);
  linkRepository.mockResolvedValue(repository());
  listTeams.mockResolvedValue([
    {
      id: 'proj-1',
      workspace_id: 'ws-1',
      name: 'Platform',
      key_prefix: 'ENG',
      description: null,
      estimate_scale: 'fibonacci',
      created_at: '2026-09-18T00:00:00Z',
      updated_at: '2026-09-18T00:00:00Z',
    },
  ]);
  vi.stubGlobal('location', { assign });
});

describe('the GitHub section', () => {
  it('offers the install when the workspace is not connected', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    render(<GithubSection workspace={workspace} />);

    expect(
      await screen.findByText('This workspace is not connected to GitHub.')
    ).toBeInTheDocument();
  });

  it('fetches the install url only when the button is pressed', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    render(<GithubSection workspace={workspace} />);

    const button = await screen.findByRole('button', {
      name: 'Install the GitHub App',
    });
    expect(getInstallUrl).not.toHaveBeenCalled();

    await userEvent.click(button);

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        'https://github.com/apps/standupless/installations/new?state=signed'
      );
    });
  });

  it('shows the account and its repositories once connected', async () => {
    render(<GithubSection workspace={workspace} />);

    expect(
      await screen.findByText('Connected to WebbPulse')
    ).toBeInTheDocument();
    expect(
      await screen.findByText('WebbPulse/standupless')
    ).toBeInTheDocument();
  });

  it('sends a null team id when a repository is unpinned', async () => {
    render(<GithubSection workspace={workspace} />);

    const select = await screen.findByLabelText('Team');
    await userEvent.selectOptions(select, '');

    await waitFor(() => {
      expect(linkRepository).toHaveBeenCalledWith('9001', null);
    });
  });

  it('disconnects without pretending the app is gone from GitHub', async () => {
    render(<GithubSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect' })
    );

    await waitFor(() => {
      expect(deleteInstallation).toHaveBeenCalled();
    });
    expect(
      screen.getByRole('link', { name: 'Manage on GitHub' })
    ).toHaveAttribute(
      'href',
      'https://github.com/settings/installations/44551122'
    );
  });
});

describe('polling a workspace that will never be connected', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('stops asking once a 404 has settled it', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    render(<GithubSection workspace={workspace} />);

    expect(
      await screen.findByText('This workspace is not connected to GitHub.')
    ).toBeInTheDocument();
    const settled = readInstallation.mock.calls.length;

    await advance(300000);

    expect(readInstallation).toHaveBeenCalledTimes(settled);
  });

  it('stops asking, and says so, when the app is not configured', async () => {
    readInstallation.mockResolvedValue({ status: 'not_configured' });
    render(<GithubSection workspace={workspace} />);

    expect(
      await screen.findByText(/The GitHub App is not set up/)
    ).toBeInTheDocument();
    const settled = readInstallation.mock.calls.length;

    await advance(300000);

    expect(readInstallation).toHaveBeenCalledTimes(settled);
    expect(
      screen.queryByRole('button', { name: 'Install the GitHub App' })
    ).not.toBeInTheDocument();
  });

  it('reads neither the repositories nor the teams while unconnected', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    render(<GithubSection workspace={workspace} />);

    await screen.findByText('This workspace is not connected to GitHub.');
    await advance(300000);

    expect(listRepositories).not.toHaveBeenCalled();
    expect(listTeams).not.toHaveBeenCalled();
  });

  it('asks again when the window regains focus after GitHub', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    render(<GithubSection workspace={workspace} />);

    await screen.findByText('This workspace is not connected to GitHub.');
    const settled = readInstallation.mock.calls.length;

    readInstallation.mockResolvedValue({
      status: 'installed',
      installation: installation(),
    });
    await act(() => {
      globalThis.dispatchEvent(new Event('focus'));
      return Promise.resolve();
    });

    await waitFor(() => {
      expect(readInstallation.mock.calls.length).toBeGreaterThan(settled);
    });
    expect(
      await screen.findByText('Connected to WebbPulse', {}, { timeout: 5000 })
    ).toBeInTheDocument();
  });

  it('asks again when the install button is pressed', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    render(<GithubSection workspace={workspace} />);

    const button = await screen.findByRole('button', {
      name: 'Install the GitHub App',
    });
    const settled = readInstallation.mock.calls.length;

    await userEvent.click(button);

    await waitFor(() => {
      expect(readInstallation.mock.calls.length).toBeGreaterThan(settled);
    });
  });

  it('keeps retrying a transient failure rather than giving up', async () => {
    readInstallation.mockRejectedValue(new Error('gateway timeout'));
    render(<GithubSection workspace={workspace} />);

    await waitFor(() => {
      expect(readInstallation).toHaveBeenCalled();
    });
    const first = readInstallation.mock.calls.length;

    await advance(300000);

    expect(readInstallation.mock.calls.length).toBeGreaterThan(first);
  });
});
