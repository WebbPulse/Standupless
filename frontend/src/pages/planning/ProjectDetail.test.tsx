/**
 * One project's page. Covers that it reads the project from the id alone,
 * that the overview shows the summary and the progress, that a status change
 * is written in place, that the issues tab lists the project's issues, and
 * that deleting is offered only to an admin and returns to the list.
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
const deleteProject = vi.fn<(id: string) => Promise<void>>();
const listIssues = vi.fn<(query: unknown) => Promise<unknown>>();
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
  deleteProject: (_w: string, id: string) => deleteProject(id),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
}));

vi.mock('../../api/issues', () => ({
  listIssues: (_w: string, query: unknown) => listIssues(query),
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

const renderPage = (entry = '/w/mine/projects/prj-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/projects/:id" element={<ProjectDetail />} />
        <Route path="/w/:slug/projects" element={<p>projects list</p>} />
      </Routes>
    </MemoryRouter>
  );

describe('ProjectDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listTeams.mockResolvedValue([engine]);
    getProject.mockResolvedValue(launch);
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
  });

  it('shows the overview from the id alone', async () => {
    renderPage();

    expect(await screen.findByText('Getting it out')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      screen.getAllByRole('link', { name: 'Projects' })[0]
    ).toHaveAttribute('href', '/w/mine/projects');
    expect(screen.getByText('Scope')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
  });

  it('reports a project it cannot read', async () => {
    getProject.mockResolvedValue(null);
    renderPage();

    expect(
      await screen.findByText(/That project does not exist/)
    ).toBeInTheDocument();
  });

  it('writes a status change in place', async () => {
    const user = userEvent.setup();
    updateProject.mockResolvedValue({ ...launch, status: 'completed' });
    renderPage();

    await screen.findByText('Getting it out');
    const [status] = screen.getAllByRole('button', {
      name: /^Status: /,
    });
    if (status === undefined) throw new Error('no status control');
    await user.click(status);
    await user.click(await screen.findByRole('option', { name: /Completed/ }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ status: 'completed' });
    });
  });

  it('lists the project issues on the issues tab', async () => {
    renderPage('/w/mine/projects/prj-1?tab=issues');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 'prj-1' })
      );
    });
    expect(screen.getByRole('tab', { name: /^Issues/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('deletes the project and returns to the list', async () => {
    const user = userEvent.setup();
    deleteProject.mockResolvedValue(undefined);
    renderPage();

    await screen.findByText('Getting it out');
    await user.click(screen.getByRole('button', { name: 'Project actions' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Delete project' })
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete project' })
    );

    await waitFor(() => {
      expect(deleteProject).toHaveBeenCalledWith('prj-1');
    });
    expect(await screen.findByText('projects list')).toBeInTheDocument();
  });

  it('does not offer deleting to a role that is not an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listTeams.mockResolvedValue([{ ...engine, role: 'member' }]);
    renderPage();

    await screen.findByText('Getting it out');
    expect(
      screen.queryByRole('button', { name: 'Project actions' })
    ).toBeNull();
  });
});
