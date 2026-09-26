/**
 * The workspace projects list. Covers that it fans the read out over every
 * visible team and merges what comes back, that the team and status filters
 * narrow it, that each row links to the project with the team it belongs to,
 * and that a role which may not write is not offered the create control.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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

const listProjects =
  vi.fn<
    (query: { team_id: string; cursor?: string }) => Promise<ProjectListRead>
  >();
const createProject = vi.fn<(body: ProjectCreate) => Promise<ProjectRead>>();
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
  listProjects: (_w: string, query: { team_id: string; cursor?: string }) =>
    listProjects(query),
  createProject: (_w: string, body: ProjectCreate) => createProject(body),
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

/** The team most rows belong to. */
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

/** A second team, so the fan-out and the team filter have something to do. */
const design: TeamRead = {
  ...engine,
  id: 'team-2',
  name: 'Design',
  key_prefix: 'DES',
};

/** One project as the planning route answers it. */
const launch: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: null,
  name: 'Launch',
  description: null,
  target_date: '2026-10-01',
  status: 'in_progress',
  counts: { todo: 1, in_progress: 1, done: 2, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** A project on the other team, planned rather than running. */
const rebrand: ProjectRead = {
  ...launch,
  project_id: 'prj-2',
  team_id: 'team-2',
  name: 'Rebrand',
  target_date: '2026-11-01',
  status: 'planned',
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

/** Answers each team's read with the projects that belong to it. */
const answerByTeam = (): void => {
  listProjects.mockImplementation((query) =>
    Promise.resolve({
      projects: [launch, rebrand].filter(
        (row) => row.team_id === query.team_id
      ),
      next_cursor: null,
    })
  );
};

const renderPage = (entry = '/w/mine/projects') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/projects" element={<Projects />} />
      </Routes>
    </MemoryRouter>
  );

describe('Projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listTeams.mockResolvedValue([engine, design]);
    answerByTeam();
  });

  it('merges the projects of every visible team', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-1' });
    expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-2' });
  });

  it('loads later cursor pages for each visible team', async () => {
    const later = { ...launch, project_id: 'prj-3', name: 'Follow-up' };
    listProjects.mockImplementation((query) => {
      if (query.team_id === 'team-1') {
        return Promise.resolve(
          query.cursor === 'next-engine'
            ? { projects: [later], next_cursor: null }
            : { projects: [launch], next_cursor: 'next-engine' }
        );
      }
      return Promise.resolve({ projects: [rebrand], next_cursor: null });
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /Follow-up/ })
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledWith({
      team_id: 'team-1',
      cursor: 'next-engine',
    });
  });

  it('shows an initial team read failure beside successful rows and recovers', async () => {
    let failing = true;
    listProjects.mockImplementation((query) => {
      if (query.team_id === 'team-1' && failing) {
        return Promise.reject(new Error('temporary failure'));
      }
      return Promise.resolve({
        projects: query.team_id === 'team-1' ? [launch] : [rebrand],
        next_cursor: null,
      });
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Engine: Could not load projects. Try again shortly.'
      );
    });
    expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Loading projects' })
    ).toBeNull();
    expect(screen.queryByText(/No projects match/)).toBeNull();

    failing = false;
    fireEvent.focus(window);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('shows a later cursor failure beside successful rows and recovers', async () => {
    let failing = true;
    const later = { ...launch, project_id: 'prj-3', name: 'Follow-up' };
    listProjects.mockImplementation((query) => {
      if (query.team_id === 'team-2') {
        return Promise.resolve({ projects: [rebrand], next_cursor: null });
      }
      if (query.cursor === undefined) {
        return Promise.resolve({ projects: [launch], next_cursor: 'next' });
      }
      return failing
        ? Promise.reject(new Error('temporary failure'))
        : Promise.resolve({ projects: [later], next_cursor: null });
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Engine: Could not load projects. Try again shortly.'
      );
    });
    expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Loading projects' })
    ).toBeNull();

    failing = false;
    fireEvent.focus(window);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: /Follow-up/ })
      ).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(listProjects).toHaveBeenCalledWith({
      team_id: 'team-1',
      cursor: 'next',
    });
  });

  it('shows a failed team list without a spinner and recovers', async () => {
    listTeams.mockRejectedValue(new Error('temporary failure'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Could not load teams. Try again shortly.'
      );
    });
    expect(
      screen.queryByRole('status', { name: 'Loading projects' })
    ).toBeNull();
    expect(screen.queryByText(/No projects match/)).toBeNull();

    listTeams.mockResolvedValue([engine, design]);
    fireEvent.focus(window);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('links a row to its project carrying the team it belongs to', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toHaveAttribute(
        'href',
        '/w/mine/projects/prj-1?team=ENG'
      );
    });
  });

  it('reads only the named team when the team filter is set', async () => {
    renderPage('/w/mine/projects?team=DES');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /Launch/ })).toBeNull();
    expect(listProjects).not.toHaveBeenCalledWith({ team_id: 'team-1' });
  });

  it('narrows the merged list by status', async () => {
    renderPage('/w/mine/projects?status=planned');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /Launch/ })).toBeNull();
  });

  it('says so when nothing matches the filters', async () => {
    renderPage('/w/mine/projects?status=done');

    await waitFor(() => {
      expect(
        screen.getByText(/No projects match these filters/)
      ).toBeInTheDocument();
    });
  });

  it('creates a project against the team the dialog names', async () => {
    createProject.mockResolvedValue(launch);
    renderPage('/w/mine/projects?team=ENG');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Migration');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    );

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith({
        team_id: 'team-1',
        name: 'Migration',
      });
    });
  });

  it('does not offer creating to a guest with no team role', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...noRole } = engine;
    listTeams.mockResolvedValue([noRole]);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('offers creation on a writable team after a read-only guest team', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...readOnly } = engine;
    listTeams.mockResolvedValue([readOnly, { ...design, role: 'member' }]);
    createProject.mockResolvedValue(rebrand);
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Rebrand/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = within(screen.getByRole('dialog'));
    const teamSelect = dialog.getByLabelText('Team');
    expect(teamSelect).toHaveValue('DES');
    await userEvent.type(screen.getByLabelText('Name'), 'Guest project');
    await userEvent.selectOptions(teamSelect, 'ENG');
    expect(
      screen.getByRole('button', { name: 'Create project' })
    ).toBeDisabled();
    await userEvent.selectOptions(teamSelect, 'DES');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create project' })
    );

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith({
        team_id: 'team-2',
        name: 'Guest project',
      });
    });
  });

  it('respects an explicit read-only team filter for a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...readOnly } = engine;
    listTeams.mockResolvedValue([readOnly, { ...design, role: 'member' }]);
    renderPage('/w/mine/projects?team=ENG');

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /Launch/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });
});
