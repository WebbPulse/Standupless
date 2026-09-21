/**
 * The projects page. Covers that a project's status is written rather than
 * derived, which is the one thing that distinguishes this page from the cycles
 * one, and the same read, filter and role boundaries.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectCreate,
  ProjectListRead,
  ProjectRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Projects from './Projects';

const listProjects = vi.fn<(query: unknown) => Promise<ProjectListRead>>();
const createProject = vi.fn<(body: ProjectCreate) => Promise<ProjectRead>>();
const updateProject =
  vi.fn<(id: string, body: unknown) => Promise<ProjectRead>>();
const deleteProject = vi.fn<(id: string) => Promise<void>>();
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
  listProjects: (_w: string, query: unknown) => listProjects(query),
  createProject: (_w: string, body: ProjectCreate) => createProject(body),
  updateProject: (_w: string, id: string, body: unknown) =>
    updateProject(id, body),
  deleteProject: (_w: string, id: string) => deleteProject(id),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
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

const team: TeamRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const project: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  name: 'Public beta',
  description: null,
  target_date: '2026-10-01',
  status: 'planned',
  counts: { todo: 2, in_progress: 0, done: 1, cancelled: 0, total: 3 },
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/projects']}>
      <Routes>
        <Route
          path="/w/:slug/team/:keyPrefix/projects"
          element={<Projects />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listProjects.mockReset();
  createProject.mockReset();
  updateProject.mockReset();
  deleteProject.mockReset();
  listTeams.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  listTeams.mockResolvedValue([team]);
  listProjects.mockResolvedValue({
    projects: [project],
    next_cursor: null,
  });
  createProject.mockResolvedValue(project);
  updateProject.mockResolvedValue(project);
  deleteProject.mockResolvedValue(undefined);
});

describe('reading the list', () => {
  it('reads under the team the route names', async () => {
    renderPage();

    await waitFor(() => {
      expect(listProjects).toHaveBeenCalledWith({ team_id: 'proj-1' });
    });
  });

  it('draws the project with its target date and its counts', async () => {
    renderPage();

    expect(await screen.findByText('Public beta')).toBeInTheDocument();
    expect(screen.getByText('2026-10-01')).toBeInTheDocument();
    expect(screen.getByText(/3 issues/)).toBeInTheDocument();
  });

  it('names the absence of a target date rather than drawing nothing', async () => {
    listProjects.mockResolvedValue({
      projects: [{ ...project, target_date: null }],
      next_cursor: null,
    });

    renderPage();

    expect(await screen.findByText('No target date')).toBeInTheDocument();
  });

  it('says so when the team has no projects yet', async () => {
    listProjects.mockResolvedValue({ projects: [], next_cursor: null });

    renderPage();

    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
  });

  it('re-reads under the status filter rather than hiding rows on screen', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');

    await waitFor(() => {
      expect(listProjects).toHaveBeenCalledWith({
        team_id: 'proj-1',
        status: 'done',
      });
    });
  });

  it('shows the team is invisible rather than an empty list', async () => {
    listTeams.mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(
        'That team does not exist, or you are not a member of it.'
      )
    ).toBeInTheDocument();
  });
});

describe('writing', () => {
  it('creates without a target date when none was given', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.type(screen.getByLabelText('New project'), 'GA');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    );

    await waitFor(() => {
      expect(createProject).toHaveBeenCalled();
    });
    const body = createProject.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('target_date');
    expect(body?.name).toBe('GA');
    expect(body?.team_id).toBe('proj-1');
  });

  it('refuses to create without a name', async () => {
    renderPage();
    await screen.findByText('Public beta');

    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeDisabled();
  });

  it('writes a status directly, unlike a cycle whose status is derived', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.selectOptions(
      screen.getByLabelText('Status of Public beta'),
      'in_progress'
    );

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        team_id: 'proj-1',
        status: 'in_progress',
      });
    });
  });

  it('deletes as an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete Public beta' })
    );

    await waitFor(() => {
      expect(deleteProject).toHaveBeenCalledWith('prj-1');
    });
  });
});

describe('what a role is offered', () => {
  it('draws no create form and locks the status for a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...roleless } = team;
    listTeams.mockResolvedValue([roleless]);

    renderPage();
    await screen.findByText('Public beta');

    expect(screen.queryByLabelText('New project')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status of Public beta')).toBeDisabled();
  });

  it('draws no delete control for a plain member', async () => {
    renderPage();
    await screen.findByText('Public beta');

    expect(
      screen.queryByRole('button', { name: 'Delete Public beta' })
    ).not.toBeInTheDocument();
  });
});
