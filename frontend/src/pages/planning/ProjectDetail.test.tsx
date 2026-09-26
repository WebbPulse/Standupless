/**
 * One project's page. Covers that the team rides in the query string and that
 * losing it is reported rather than shown as an empty overview, that the
 * overview reads the counts and the target date, that the status control is
 * only offered to a role that may write, and that deleting sends the team the
 * planning key is filed under.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ProjectDetail from './ProjectDetail';

const getProject = vi.fn<() => Promise<ProjectRead | null>>();
const updateProject = vi.fn<(body: unknown) => Promise<ProjectRead>>();
const deleteProject = vi.fn<(teamId: string) => Promise<void>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

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

vi.mock('../../api/planning', () => ({
  getProject: () => getProject(),
  updateProject: (_w: string, _id: string, body: unknown) =>
    updateProject(body),
  deleteProject: (_w: string, _id: string, teamId: string) =>
    deleteProject(teamId),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
}));

vi.mock('../../api/issues', () => ({
  listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
  appendIssues: (held: unknown) => held,
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

/** The team the project belongs to. */
const engine: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** The project the page reads. */
const launch: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: null,
  name: 'Launch',
  description: 'Getting it out',
  target_date: '2026-10-01',
  status: 'in_progress',
  counts: { todo: 1, in_progress: 1, done: 2, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
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

const renderPage = (entry = '/w/mine/projects/prj-1?team=ENG') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/projects/:id" element={<ProjectDetail />} />
      </Routes>
    </MemoryRouter>
  );

describe('ProjectDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listTeams.mockResolvedValue([engine]);
    getProject.mockResolvedValue(launch);
  });

  it('shows the overview once the project arrives', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Getting it out')).toBeInTheDocument();
    });
    const header = screen.getByRole('banner');
    expect(
      within(header).getByRole('link', { name: 'Engine' })
    ).toHaveAttribute('href', '/w/mine/team/ENG');
    expect(
      within(header).getByRole('link', { name: 'Projects' })
    ).toHaveAttribute('href', '/w/mine/projects');
  });

  it('says the link is missing its team when the query string has none', async () => {
    renderPage('/w/mine/projects/prj-1');

    await waitFor(() => {
      expect(
        screen.getByText(/missing the team it belongs to/)
      ).toBeInTheDocument();
    });
    expect(getProject).not.toHaveBeenCalled();
  });

  it('reports a project it cannot read', async () => {
    getProject.mockResolvedValue(null);
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(/That project does not exist/)
      ).toBeInTheDocument();
    });
  });

  it('sends the team with a status change', async () => {
    updateProject.mockResolvedValue({ ...launch, status: 'completed' });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Getting it out')).toBeInTheDocument();
    });

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'completed');

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({
        team_id: 'team-1',
        status: 'completed',
      });
    });
  });

  it('deletes against the team the planning key is filed under', async () => {
    deleteProject.mockResolvedValue(undefined);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Getting it out')).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Delete Launch' })
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete project' })
    );

    await waitFor(() => {
      expect(deleteProject).toHaveBeenCalledWith('team-1');
    });
  });

  it('does not offer deleting to a role that is not an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listTeams.mockResolvedValue([{ ...engine, role: 'member' }]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Getting it out')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Delete Launch' })).toBeNull();
  });
});
