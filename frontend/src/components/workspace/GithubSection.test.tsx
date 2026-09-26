/**
 * The GitHub settings section. Covers that a workspace with no installation is
 * offered the install rather than an empty repository list, that the install
 * URL is fetched at the moment the button is pressed rather than held from the
 * page load, that pinning a repository to every team sends an explicit null
 * rather than an empty string, and that a focus read which finds a new
 * installation resumes polling instead of being settled by the stale answer.
 * Also covers the disconnect confirm and the toast GitHub's return sends.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
  manage_url:
    'https://github.com/organizations/WebbPulse/settings/installations/44551122',
  avatar_url: 'https://avatars.githubusercontent.com/u/1',
  suspended: false,
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

/** Renders the section inside a router at the given settings URL. */
const renderSection = (path = '/w/engineering/settings') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <GithubSection workspace={workspace} />
    </MemoryRouter>
  );

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
    renderSection();

    expect(
      await screen.findByText('This workspace is not connected to GitHub.')
    ).toBeInTheDocument();
  });

  it('fetches the install url only when the button is pressed', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    renderSection();

    const button = await screen.findByRole('button', {
      name: 'Connect GitHub',
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
    renderSection();

    expect(
      await screen.findByText('Connected to WebbPulse')
    ).toBeInTheDocument();
    expect(
      await screen.findByText('WebbPulse/standupless')
    ).toBeInTheDocument();
  });

  it('sends a null team id when a repository is unpinned', async () => {
    renderSection();

    const select = await screen.findByLabelText('Team');
    await userEvent.selectOptions(select, '');

    await waitFor(() => {
      expect(linkRepository).toHaveBeenCalledWith('9001', null);
    });
  });

  it('disconnects only after the confirm, and links to GitHub to remove the app', async () => {
    renderSection();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect' })
    );
    expect(deleteInstallation).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Disconnect GitHub?');

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Disconnect' })
    );

    await waitFor(() => {
      expect(deleteInstallation).toHaveBeenCalled();
    });
    expect(
      screen.getByRole('link', { name: 'Manage on GitHub' })
    ).toHaveAttribute(
      'href',
      'https://github.com/organizations/WebbPulse/settings/installations/44551122'
    );
  });

  it('keeps the installation when the confirm is cancelled', async () => {
    renderSection();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect' })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(deleteInstallation).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('falls back to the html url when no manage url is known', async () => {
    readInstallation.mockResolvedValue({
      status: 'installed',
      installation: installation({ manage_url: '' }),
    });
    renderSection();

    expect(
      await screen.findByRole('link', { name: 'Manage on GitHub' })
    ).toHaveAttribute(
      'href',
      'https://github.com/settings/installations/44551122'
    );
  });

  it('says when the app is suspended on GitHub', async () => {
    readInstallation.mockResolvedValue({
      status: 'installed',
      installation: installation({ suspended: true }),
    });
    renderSection();

    expect(await screen.findByText('Suspended')).toBeInTheDocument();
    expect(
      screen.getByText(/The App is suspended on WebbPulse/)
    ).toBeInTheDocument();
  });

  it('counts the repositories the installation covers', async () => {
    listRepositories.mockResolvedValue([
      repository(),
      repository({
        repository_id: '9002',
        full_name: 'WebbPulse/web',
        private: true,
      }),
    ]);
    renderSection();

    expect(
      await screen.findByText('Organization, 2 repositories selected')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Private')).toBeInTheDocument();
  });

  it('offers a retry when the installation cannot be read', async () => {
    readInstallation.mockRejectedValue(new Error('gateway timeout'));
    renderSection();

    expect(
      await screen.findByRole('button', { name: 'Try again' })
    ).toBeInTheDocument();
  });

  it('shows the outcome GitHub sent back', async () => {
    renderSection('/w/engineering/settings?github=installed');

    expect(await screen.findByText('GitHub connected')).toBeInTheDocument();
  });

  it('says plainly when the connect link was refused', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    renderSection('/w/engineering/settings?github=taken');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Already connected elsewhere'
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
    renderSection();

    expect(
      await screen.findByText('This workspace is not connected to GitHub.')
    ).toBeInTheDocument();
    const settled = readInstallation.mock.calls.length;

    await advance(300000);

    expect(readInstallation).toHaveBeenCalledTimes(settled);
  });

  it('stops asking, and says so, when the app is not configured', async () => {
    readInstallation.mockResolvedValue({ status: 'not_configured' });
    renderSection();

    expect(
      await screen.findByText(/The GitHub App is not set up/)
    ).toBeInTheDocument();
    const settled = readInstallation.mock.calls.length;

    await advance(300000);

    expect(readInstallation).toHaveBeenCalledTimes(settled);
    expect(
      screen.getByRole('button', { name: 'Connect GitHub' })
    ).toBeDisabled();
  });

  it('reads neither the repositories nor the teams while unconnected', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    renderSection();

    await screen.findByText('This workspace is not connected to GitHub.');
    await advance(300000);

    expect(listRepositories).not.toHaveBeenCalled();
    expect(listTeams).not.toHaveBeenCalled();
  });

  it('asks again when the window regains focus after GitHub', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    renderSection();

    await screen.findByText('This workspace is not connected to GitHub.');
    await advance(0);
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
    renderSection();

    const button = await screen.findByRole('button', {
      name: 'Connect GitHub',
    });
    const settled = readInstallation.mock.calls.length;

    await userEvent.click(button);

    await waitFor(() => {
      expect(readInstallation.mock.calls.length).toBeGreaterThan(settled);
    });
  });

  it('keeps retrying a transient failure rather than giving up', async () => {
    readInstallation.mockRejectedValue(new Error('gateway timeout'));
    renderSection();

    await waitFor(() => {
      expect(readInstallation).toHaveBeenCalled();
    });
    const first = readInstallation.mock.calls.length;

    await advance(300000);

    expect(readInstallation.mock.calls.length).toBeGreaterThan(first);
  });
});

describe('returning from GitHub', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  /** Renders a settled section, focuses the window, and holds the focus read open. */
  const focusWithPendingRead = async (): Promise<
    (value: InstallationState) => Promise<void>
  > => {
    let resolveFocusRead!: (value: InstallationState) => void;
    readInstallation
      .mockResolvedValueOnce({ status: 'not_installed' })
      .mockReturnValueOnce(
        new Promise<InstallationState>((resolve) => {
          resolveFocusRead = resolve;
        })
      );
    renderSection();
    await advance(0);
    expect(
      screen.getByText('This workspace is not connected to GitHub.')
    ).toBeInTheDocument();
    expect(readInstallation).toHaveBeenCalledTimes(1);

    await act(async () => {
      globalThis.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readInstallation).toHaveBeenCalledTimes(2);

    return async (value: InstallationState): Promise<void> => {
      resolveFocusRead(value);
      await advance(0);
    };
  };

  it('keeps polling once the focus read finds the installation', async () => {
    readInstallation.mockResolvedValue({
      status: 'installed',
      installation: installation(),
    });
    const answer = await focusWithPendingRead();

    await answer({ status: 'installed', installation: installation() });
    expect(screen.getByText('Connected to WebbPulse')).toBeInTheDocument();

    await advance(90000);
    expect(readInstallation).toHaveBeenCalledTimes(5);
  });

  it('settles again when the focus read still finds no installation', async () => {
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    const answer = await focusWithPendingRead();

    await answer({ status: 'not_installed' });
    expect(
      screen.getByText('This workspace is not connected to GitHub.')
    ).toBeInTheDocument();

    await advance(90000);
    expect(readInstallation).toHaveBeenCalledTimes(2);
  });
});
