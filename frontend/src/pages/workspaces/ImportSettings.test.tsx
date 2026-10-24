/**
 * The issue import page. It opens on the import assistant, one row per
 * provider; Asana, Shortcut and Jira open the file flow with their preset
 * chosen and a note that their API import is coming, and the page links to
 * the export below. For a CSV an admin picks a source, a team and a file,
 * dry runs it and sees the row problems, remaps a column, which runs the dry
 * run again with the change, and starts the import with the same body. For
 * Linear they paste a key, load its teams, map each and start, and the key is
 * cleared once the job is queued. For GitHub they pick a repository the App
 * covers and a team and start, or are told why they cannot when the App is
 * missing or suspended. A running job can be cancelled. Anyone below admin is
 * told they cannot.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type { InstallationState } from '../../api/integrations';
import type {
  GitHubImportRepositoryRead,
  GitHubImportRequest,
  GithubInstallationRead,
  IssueImportPreviewRead,
  IssueImportRead,
  IssueImportRequest,
  LinearImportRequest,
  LinearTeamRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ImportSettings from './ImportSettings';

const listIssueImports = vi.fn<() => Promise<IssueImportRead[]>>();
const previewIssueImport =
  vi.fn<(body: IssueImportRequest) => Promise<IssueImportPreviewRead>>();
const startIssueImport =
  vi.fn<(body: IssueImportRequest) => Promise<IssueImportRead>>();
const listLinearTeams = vi.fn<(apiKey: string) => Promise<LinearTeamRead[]>>();
const startLinearImport =
  vi.fn<(body: LinearImportRequest) => Promise<IssueImportRead>>();
const cancelIssueImport =
  vi.fn<(importId: string) => Promise<IssueImportRead>>();
const listGitHubImportRepositories =
  vi.fn<() => Promise<GitHubImportRepositoryRead[]>>();
const startGitHubImport =
  vi.fn<(body: GitHubImportRequest) => Promise<IssueImportRead>>();
const readInstallation = vi.fn<() => Promise<InstallationState>>();

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

vi.mock('../../api/imports', () => ({
  listIssueImports: () => listIssueImports(),
  previewIssueImport: (_workspaceId: string, body: IssueImportRequest) =>
    previewIssueImport(body),
  startIssueImport: (_workspaceId: string, body: IssueImportRequest) =>
    startIssueImport(body),
  listLinearTeams: (_workspaceId: string, apiKey: string) =>
    listLinearTeams(apiKey),
  startLinearImport: (_workspaceId: string, body: LinearImportRequest) =>
    startLinearImport(body),
  cancelIssueImport: (_workspaceId: string, importId: string) =>
    cancelIssueImport(importId),
  listGitHubImportRepositories: () => listGitHubImportRepositories(),
  startGitHubImport: (_workspaceId: string, body: GitHubImportRequest) =>
    startGitHubImport(body),
}));

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return { ...actual, readInstallation: () => readInstallation() };
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** One team in the shape the team list answers with. */
const team = (id: string, name: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: name.slice(0, 3).toUpperCase(),
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
});

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: () => ({
    data: [team('team-1', 'Platform'), team('team-2', 'Web')],
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
    workspaceId: 'ws-1',
  }),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'engineering',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** One import job in the shape the contract answers with. */
const job = (over: Partial<IssueImportRead> = {}): IssueImportRead => ({
  import_id: 'imp-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  preset: 'jira',
  file_name: 'jira.csv',
  status: 'completed',
  requested_by: 'user-1',
  created_at: '2026-10-07T00:00:00Z',
  updated_at: '2026-10-07T00:00:00Z',
  total_rows: 3,
  processed_rows: 3,
  created_count: 2,
  skipped_count: 1,
  labels_created: 1,
  problem_count: 1,
  problems: [],
  problems_truncated: false,
  ...over,
});

const CSV = 'Summary,Issue key,Status,Owner\nFix login,PROJ-1,Done,a\n';

/** A dry run of CSV with one skipped row. */
const dryRun = (
  over: Partial<IssueImportPreviewRead> = {}
): IssueImportPreviewRead => ({
  headers: ['Summary', 'Issue key', 'Status', 'Owner'],
  mapping: {
    title: 'Summary',
    status: 'Status',
    source_key: 'Issue key',
    assignee: null,
  },
  total_rows: 2,
  importable_rows: 1,
  problems: [
    {
      row: 3,
      field: 'title',
      severity: 'error',
      message: 'The title is empty.',
    },
  ],
  problems_truncated: false,
  rows: [],
  new_labels: ['docs'],
  statuses: [{ source: 'Done', status_name: 'Done', count: 1 }],
  ...over,
});

/** An installation of the App on the WebbPulse organization. */
const installation = (
  over: Partial<GithubInstallationRead> = {}
): GithubInstallationRead => ({
  installation_id: '42',
  account_login: 'WebbPulse',
  account_type: 'Organization',
  repository_selection: 'selected',
  html_url: 'https://github.com/WebbPulse',
  manage_url:
    'https://github.com/organizations/WebbPulse/settings/installations/42',
  avatar_url: '',
  suspended: false,
  label_set: { enabled: false, include_public: false, queued: false },
  installed_by: 'user-1',
  installed_at: '2026-10-01T00:00:00Z',
  repository_count: 2,
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <ImportSettings />
    </MemoryRouter>
  );

/** Opens one row of the import assistant by the provider it names. */
const chooseProvider = async (
  user: ReturnType<typeof userEvent.setup>,
  name: RegExp
) => {
  await user.click(screen.getByRole('button', { name }));
};

/** Opens the Jira row, which lands on the file flow with the Jira preset. */
const chooseCsv = async (user: ReturnType<typeof userEvent.setup>) => {
  await chooseProvider(user, /^Jira/);
};

/** Opens the GitHub row of the import assistant. */
const chooseGitHub = async (user: ReturnType<typeof userEvent.setup>) => {
  await chooseProvider(user, /^GitHub/);
};

/** Opens the Jira file flow unless it is open, picks the fixture file, then dry runs it. */
const pickAndCheck = async (user: ReturnType<typeof userEvent.setup>) => {
  if (screen.queryByRole('list', { name: 'Import assistant' }) !== null) {
    await chooseCsv(user);
  }
  await user.upload(
    screen.getByLabelText('CSV file'),
    new File([CSV], 'jira.csv', { type: 'text/csv' })
  );
  const check = screen.getByRole('button', { name: 'Check file' });
  await waitFor(() => {
    expect(check).toBeEnabled();
  });
  await user.click(check);
};

beforeEach(() => {
  listIssueImports.mockReset();
  previewIssueImport.mockReset();
  startIssueImport.mockReset();
  listLinearTeams.mockReset();
  startLinearImport.mockReset();
  cancelIssueImport.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
  listIssueImports.mockResolvedValue([job()]);
  previewIssueImport.mockResolvedValue(dryRun());
  startIssueImport.mockResolvedValue(job({ status: 'queued' }));
  listLinearTeams.mockResolvedValue([
    { id: 'lin-team-1', key: 'PLA', name: 'Linear Platform' },
  ]);
  startLinearImport.mockResolvedValue(
    job({ kind: 'linear', status: 'queued', file_name: '' })
  );
  cancelIssueImport.mockResolvedValue(job({ status: 'cancelled' }));
  listGitHubImportRepositories.mockReset();
  startGitHubImport.mockReset();
  readInstallation.mockReset();
  readInstallation.mockResolvedValue({
    status: 'installed',
    installation: installation(),
  });
  listGitHubImportRepositories.mockResolvedValue([
    {
      repository_id: '101',
      full_name: 'WebbPulse/api',
      private: false,
      team_id: null,
    },
    {
      repository_id: '102',
      full_name: 'WebbPulse/web',
      private: true,
      team_id: 'team-2',
    },
  ]);
  startGitHubImport.mockResolvedValue(
    job({ kind: 'github', status: 'queued', file_name: 'WebbPulse/api' })
  );
});

describe('the issue import page', () => {
  it('opens on the import assistant with a row per provider', () => {
    renderPage();

    const assistant = screen.getByRole('list', { name: 'Import assistant' });
    const rows = within(assistant).getAllByRole('button');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringMatching(/^Asana/),
      expect.stringMatching(/^Shortcut/),
      expect.stringMatching(/^GitHub/),
      expect.stringMatching(/^Jira/),
      expect.stringMatching(/^Linear/),
      expect.stringMatching(/^CSV or file/),
    ]);
    expect(screen.queryByLabelText('Linear API key')).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'export settings' })
    ).toHaveAttribute('href', '/w/engineering/settings/export');
  });

  it.each([
    [/^Asana/, 'asana', 'Asana'],
    [/^Shortcut/, 'shortcut', 'Shortcut'],
    [/^Jira/, 'jira', 'Jira'],
  ])(
    'opens the file flow with the preset chosen for %s',
    async (row, preset, title) => {
      const user = userEvent.setup();
      renderPage();

      await chooseProvider(user, row);

      expect(screen.getByLabelText('Source')).toHaveValue(preset);
      expect(
        screen.getByText(/Connect via API \(coming soon\)/)
      ).toHaveTextContent(`export from ${title} as CSV`);
      expect(screen.getByLabelText('CSV file')).toHaveAttribute(
        'accept',
        '.csv,text/csv'
      );
    }
  );

  it('opens any file on the generic preset and goes back to the list', async () => {
    const user = userEvent.setup();
    renderPage();

    await chooseProvider(user, /^CSV or file/);

    expect(screen.getByLabelText('Source')).toHaveValue('generic');
    expect(screen.queryByText(/coming soon/)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'All import sources' })
    );
    expect(
      screen.getByRole('list', { name: 'Import assistant' })
    ).toBeInTheDocument();
  });

  it('sends a Trello board without its activity log', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseProvider(user, /^CSV or file/);
    await user.selectOptions(screen.getByLabelText('Source'), 'trello');

    const input = screen.getByLabelText('Board JSON');
    expect(input).toHaveAttribute('accept', '.json,application/json');
    const board = { name: 'Launch', cards: [], actions: [{ id: 'a1' }] };
    await user.upload(
      input,
      new File([JSON.stringify(board)], 'board.json', {
        type: 'application/json',
      })
    );
    const check = screen.getByRole('button', { name: 'Check file' });
    await waitFor(() => {
      expect(check).toBeEnabled();
    });
    await user.click(check);

    await waitFor(() => {
      expect(previewIssueImport).toHaveBeenCalledWith(
        expect.objectContaining({
          preset: 'trello',
          csv: JSON.stringify({ name: 'Launch', cards: [] }),
          file_name: 'board.json',
        })
      );
    });
  });

  it('lists a finished import with what it created', async () => {
    renderPage();

    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(
      screen.getByText(/2 issues created, 1 skipped, 1 new label/)
    ).toBeInTheDocument();
  });

  it('dry runs the file against the chosen team and preset', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseCsv(user);

    await user.selectOptions(screen.getByLabelText('Team'), 'team-2');
    await user.selectOptions(screen.getByLabelText('Source'), 'linear');
    await pickAndCheck(user);

    await waitFor(() => {
      expect(previewIssueImport).toHaveBeenCalledWith({
        team_id: 'team-2',
        preset: 'linear',
        csv: CSV,
        file_name: 'jira.csv',
        mapping: null,
      });
    });
    const dry = await screen.findByLabelText('Dry run');
    expect(
      within(dry).getByText(/1 issue will be created from 2 rows/)
    ).toBeInTheDocument();
    expect(within(dry).getByText('The title is empty.')).toBeInTheDocument();
    expect(within(dry).getByText('Skipped')).toBeInTheDocument();
    expect(within(dry).getByText('docs')).toBeInTheDocument();
  });

  it('runs the dry run again when a column is remapped', async () => {
    const user = userEvent.setup();
    renderPage();
    await pickAndCheck(user);

    await user.selectOptions(await screen.findByLabelText('Assignee'), 'Owner');

    await waitFor(() => {
      expect(previewIssueImport).toHaveBeenLastCalledWith(
        expect.objectContaining({ mapping: { assignee: 'Owner' } })
      );
    });
  });

  it('starts the import with the checked body', async () => {
    const user = userEvent.setup();
    renderPage();
    await pickAndCheck(user);

    await user.click(
      await screen.findByRole('button', { name: 'Import 1 issue' })
    );

    await waitFor(() => {
      expect(startIssueImport).toHaveBeenCalledWith({
        team_id: 'team-1',
        preset: 'jira',
        csv: CSV,
        file_name: 'jira.csv',
        mapping: null,
      });
    });
  });

  it('cannot start before a dry run', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseCsv(user);

    expect(
      await screen.findByRole('button', { name: 'Start import' })
    ).toBeDisabled();
  });

  it('refuses a second start while one is importing', async () => {
    const user = userEvent.setup();
    listIssueImports.mockResolvedValue([
      job({ status: 'running', processed_rows: 100, total_rows: 400 }),
    ]);
    renderPage();
    await chooseCsv(user);

    expect(
      await screen.findByRole('button', { name: 'Import in progress' })
    ).toBeDisabled();
    expect(screen.getByText(/100 of 400 rows/)).toBeInTheDocument();
  });

  it('imports Linear teams into the team with the same key and clears the key', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseProvider(user, /^Linear/);

    const key = screen.getByLabelText('Linear API key');
    await user.type(key, 'lin_api_example');
    await user.click(screen.getByRole('button', { name: 'Load teams' }));

    expect(
      await screen.findByLabelText('Standupless team for Linear Platform')
    ).toHaveValue('team-1');
    expect(listLinearTeams).toHaveBeenCalledWith('lin_api_example');

    await user.click(screen.getByRole('button', { name: 'Import 1 team' }));

    await waitFor(() => {
      expect(startLinearImport).toHaveBeenCalledWith({
        api_key: 'lin_api_example',
        teams: [{ linear_team_id: 'lin-team-1', team_id: 'team-1' }],
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Linear API key')).toHaveValue('');
    });
  });

  it('cancels a running import', async () => {
    const user = userEvent.setup();
    listIssueImports.mockResolvedValue([
      job({ status: 'running', processed_rows: 100, total_rows: 400 }),
    ]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(cancelIssueImport).toHaveBeenCalledWith('imp-1');
    });
  });

  it('lists what a finished Linear import brought over', async () => {
    listIssueImports.mockResolvedValue([
      job({
        kind: 'linear',
        file_name: '',
        created_count: 4,
        updated_count: 0,
        counts: { comments: 3, relations: 2, cycles: 1 },
        linear_teams: [
          {
            linear_team_id: 'lin-team-1',
            linear_key: 'PLA',
            name: 'Linear Platform',
            team_id: 'team-1',
          },
        ],
      }),
    ]);
    renderPage();

    expect(
      await screen.findByText('Linear PLA into Platform')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/4 issues created, 3 comments, 2 relations, 1 cycle/)
    ).toBeInTheDocument();
  });

  it('imports a GitHub repository into the team it is pinned to', async () => {
    const user = userEvent.setup();
    renderPage();
    await chooseGitHub(user);

    const repository = await screen.findByLabelText('Repository');
    expect(repository).toHaveValue('101');
    expect(screen.getByLabelText('Team')).toHaveValue('team-1');

    await user.selectOptions(repository, '102');
    expect(screen.getByLabelText('Team')).toHaveValue('team-2');
    expect(
      screen.getByRole('option', { name: 'WebbPulse/web (private)' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import issues' }));

    await waitFor(() => {
      expect(startGitHubImport).toHaveBeenCalledWith({
        repository_id: '102',
        team_id: 'team-2',
      });
    });
  });

  it('links to the GitHub settings when the App is not installed', async () => {
    const user = userEvent.setup();
    readInstallation.mockResolvedValue({ status: 'not_installed' });
    renderPage();
    await chooseGitHub(user);

    expect(
      await screen.findByText('The GitHub App is not installed')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'GitHub integration settings' })
    ).toHaveAttribute('href', '/w/engineering/settings/integrations');
    expect(listGitHubImportRepositories).not.toHaveBeenCalled();
  });

  it('says the App is suspended instead of listing repositories', async () => {
    const user = userEvent.setup();
    readInstallation.mockResolvedValue({
      status: 'installed',
      installation: installation({ suspended: true }),
    });
    renderPage();
    await chooseGitHub(user);

    expect(
      await screen.findByText('The GitHub App is suspended')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Repository')).not.toBeInTheDocument();
    expect(listGitHubImportRepositories).not.toHaveBeenCalled();
  });

  it('says so when the App covers no repositories', async () => {
    const user = userEvent.setup();
    listGitHubImportRepositories.mockResolvedValue([]);
    renderPage();
    await chooseGitHub(user);

    expect(
      await screen.findByText('No repositories to import')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Import issues' })
    ).toBeDisabled();
  });

  it('shows the start error from the server', async () => {
    const user = userEvent.setup();
    startGitHubImport.mockRejectedValue(new Error('Repository not available'));
    renderPage();
    await chooseGitHub(user);

    await user.click(
      await screen.findByRole('button', { name: 'Import issues' })
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('lists what a finished GitHub import brought over and skipped', async () => {
    listIssueImports.mockResolvedValue([
      job({
        kind: 'github',
        file_name: 'WebbPulse/api',
        created_count: 5,
        updated_count: 2,
        skipped_count: 1,
        counts: {
          issues_created: 5,
          issues_updated: 2,
          comments: 4,
          already_synced: 1,
          pull_requests_skipped: 3,
        },
      }),
    ]);
    renderPage();

    expect(
      await screen.findByText('GitHub WebbPulse/api into Platform')
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /5 issues created, 2 updated, 4 comments, 1 already synced, 3 pull requests skipped/
      )
    ).toBeInTheDocument();
  });

  it('shows a running GitHub import reading issues', async () => {
    listIssueImports.mockResolvedValue([
      job({
        kind: 'github',
        status: 'running',
        file_name: 'WebbPulse/api',
        created_count: 12,
        phase: 'issues',
        phase_index: 0,
        phase_count: 1,
      }),
    ]);
    renderPage();

    expect(
      await screen.findByText(/Reading issues, 12 issues so far/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('says so when there are no imports', async () => {
    listIssueImports.mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText('No imports yet.')).toBeInTheDocument();
  });

  it('tells a member only admins can import', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      screen.getByText('Only workspace owners and admins can import issues.')
    ).toBeInTheDocument();
    expect(listIssueImports).not.toHaveBeenCalled();
  });
});
