/**
 * The issue import page. An admin picks a source, a team and a file, dry runs
 * it and sees the row problems, remaps a column, which runs the dry run again
 * with the change, and starts the import with the same body. Anyone below
 * admin is told they cannot.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  IssueImportPreviewRead,
  IssueImportRead,
  IssueImportRequest,
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
}));

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

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <ImportSettings />
    </MemoryRouter>
  );

/** Picks the CSV fixture as the file and dry runs it. */
const pickAndCheck = async (user: ReturnType<typeof userEvent.setup>) => {
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
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
  listIssueImports.mockResolvedValue([job()]);
  previewIssueImport.mockResolvedValue(dryRun());
  startIssueImport.mockResolvedValue(job({ status: 'queued' }));
});

describe('the issue import page', () => {
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
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Start import' })
    ).toBeDisabled();
  });

  it('refuses a second start while one is importing', async () => {
    listIssueImports.mockResolvedValue([
      job({ status: 'running', processed_rows: 100, total_rows: 400 }),
    ]);
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Import in progress' })
    ).toBeDisabled();
    expect(screen.getByText(/100 of 400 rows/)).toBeInTheDocument();
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
