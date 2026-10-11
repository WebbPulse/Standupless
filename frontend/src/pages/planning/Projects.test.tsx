/**
 * The workspace projects list. Covers that it reads every project the caller
 * can see in one cursor walk, groups them by status, narrows by team and
 * status from the URL, links each row to its project, edits the status and
 * health in place, draws each project's own icon, and only offers creating to a role that may write.
 * Filtered to a parent team, the list rolls in its sub-teams' projects until
 * the toggle narrows it to the team alone.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectCreate,
  ProjectListRead,
  ProjectRead,
  ProjectUpdate,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Projects from './Projects';

const listProjects =
  vi.fn<
    (query: {
      team_id?: string;
      include_sub_teams?: boolean;
      cursor?: string;
    }) => Promise<ProjectListRead>
  >();
const updateProject =
  vi.fn<(id: string, patch: ProjectUpdate) => Promise<ProjectRead>>();
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
  listProjects: (
    _w: string,
    query: { team_id?: string; include_sub_teams?: boolean; cursor?: string }
  ) => listProjects(query),
  createProject: (_w: string, body: ProjectCreate) => createProject(body),
  updateProject: (_w: string, id: string, patch: ProjectUpdate) =>
    updateProject(id, patch),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listTeamMembers: () => Promise.resolve([]),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
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
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
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

/** A team as a guest with no grant on it sees it. */
const roleless = (team: TeamRead): TeamRead => {
  const { role: _role, ...rest } = team;
  return rest;
};

const renderPage = (entry = '/w/mine/projects') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/projects" element={<Projects />} />
        <Route path="/w/:slug/projects/:id" element={<p>project page</p>} />
      </Routes>
    </MemoryRouter>
  );

describe('Projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listTeams.mockResolvedValue([engine, design]);
    listProjects.mockResolvedValue({
      projects: [launch, rebrand],
      next_cursor: null,
    });
  });

  it('reads the whole workspace in one cursor walk', async () => {
    const later = { ...launch, project_id: 'prj-3', name: 'Follow-up' };
    listProjects.mockImplementation((query) =>
      Promise.resolve(
        query.cursor === 'next'
          ? { projects: [later], next_cursor: null }
          : { projects: [launch, rebrand], next_cursor: 'next' }
      )
    );
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: 'Follow-up' })
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: 'Launch' })).toBeInTheDocument();
    expect(listProjects).toHaveBeenCalledWith({});
    expect(listProjects).toHaveBeenCalledWith({ cursor: 'next' });
  });

  it('groups the projects under their status', async () => {
    renderPage();

    const running = await screen.findByRole('region', { name: 'In progress' });
    expect(
      within(running).getByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
    const planned = screen.getByRole('region', { name: 'Planned' });
    expect(
      within(planned).getByRole('link', { name: 'Rebrand' })
    ).toBeInTheDocument();
  });

  it('groups by team from the URL', async () => {
    listProjects.mockResolvedValue({
      projects: [launch, { ...rebrand, team_ids: ['team-2'] }],
      next_cursor: null,
    });
    renderPage('/w/mine/projects?group=team');

    const engineGroup = await screen.findByRole('region', { name: 'Engine' });
    expect(
      within(engineGroup).getByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
    const designGroup = screen.getByRole('region', { name: 'Design' });
    expect(
      within(designGroup).getByRole('link', { name: 'Rebrand' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'In progress' })).toBeNull();
  });

  it('orders the rows by the Display menu choice', async () => {
    const user = userEvent.setup();
    const alpha = {
      ...launch,
      project_id: 'prj-9',
      name: 'Alpha',
      target_date: '2026-12-01',
    };
    listProjects.mockResolvedValue({
      projects: [launch, alpha],
      next_cursor: null,
    });
    renderPage('/w/mine/projects?group=none');

    await screen.findByRole('link', { name: 'Alpha' });
    const names = (): string[] =>
      screen
        .getAllByRole('link')
        .map((link) => link.getAttribute('aria-label') ?? '')
        .filter((name) => name !== '');
    expect(names()).toEqual(['Launch', 'Alpha']);

    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.selectOptions(screen.getByLabelText('Ordering'), 'name');

    expect(names()).toEqual(['Alpha', 'Launch']);
  });

  it('draws the lead as an avatar that opens the lead picker', async () => {
    renderPage();

    expect(
      await screen.findAllByRole('button', { name: 'Lead: No lead' })
    ).toHaveLength(2);
  });

  it('writes a health change from the row', async () => {
    const user = userEvent.setup();
    updateProject.mockResolvedValue({ ...launch, health: 'on_track' });
    renderPage();

    const [health] = await screen.findAllByRole('button', {
      name: 'Health: No updates',
    });
    if (health === undefined) throw new Error('no health control');
    await user.click(health);
    await user.click(await screen.findByRole('option', { name: /On track/ }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        health: 'on_track',
      });
    });
  });

  it('draws the icon and colour the project picked', async () => {
    listProjects.mockResolvedValue({
      projects: [{ ...launch, icon: 'rocket', color: '#10b981' }],
      next_cursor: null,
    });
    renderPage();

    const link = await screen.findByRole('link', { name: 'Launch' });
    const mark = link.parentElement?.querySelector('[data-icon]');
    expect(mark).toHaveAttribute('data-icon', 'rocket');
    expect(mark).toHaveAttribute('data-color', '#10b981');
  });

  it('links a row to its project page', async () => {
    renderPage();

    const link = await screen.findByRole('link', { name: 'Launch' });
    expect(link).toHaveAttribute('href', '/w/mine/projects/prj-1');
  });

  it('narrows the read to the team in the URL', async () => {
    renderPage('/w/mine/projects?team=DES');

    await waitFor(() => {
      expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-2' });
    });
  });

  it('narrows by the status in the URL', async () => {
    renderPage('/w/mine/projects?status=planned');

    await screen.findByRole('link', { name: 'Rebrand' });
    expect(screen.queryByRole('link', { name: 'Launch' })).toBeNull();
  });

  it('says so when nothing matches the filters', async () => {
    renderPage('/w/mine/projects?status=canceled');

    expect(
      await screen.findByText('No projects match these filters.')
    ).toBeInTheDocument();
  });

  it('explains projects when there are none yet', async () => {
    listProjects.mockResolvedValue({ projects: [], next_cursor: null });
    renderPage();

    expect(await screen.findByText(/No projects yet/)).toBeInTheDocument();
  });

  it('shows a failed read', async () => {
    listProjects.mockRejectedValue(new Error('temporary failure'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('creates a project and opens it', async () => {
    const user = userEvent.setup();
    createProject.mockResolvedValue({ ...launch, project_id: 'prj-9' });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'New project' })
    );
    await user.type(screen.getByLabelText('Project name'), 'Search');
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Search',
          team_ids: ['team-1'],
          status: 'planned',
        })
      );
    });
    expect(await screen.findByText('project page')).toBeInTheDocument();
  });

  it('creates a project with its icon, colour, health and priority', async () => {
    const user = userEvent.setup();
    createProject.mockResolvedValue({ ...launch, project_id: 'prj-9' });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'New project' })
    );
    await user.type(screen.getByLabelText('Project name'), 'Search');
    await user.click(screen.getByRole('button', { name: 'Icon and colour' }));
    const colours = await screen.findByRole('radiogroup', { name: 'Colour' });
    const swatch = within(colours).getAllByRole('radio')[1];
    if (swatch === undefined) throw new Error('no colour swatch');
    await user.click(swatch);
    const icons = screen.getByRole('radiogroup', { name: 'Icon' });
    const glyph = within(icons).getAllByRole('radio')[1];
    if (glyph === undefined) throw new Error('no icon');
    await user.click(glyph);
    await user.keyboard('{Escape}');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Health/ }));
    await user.click(await screen.findByRole('option', { name: /On track/ }));
    await user.click(within(dialog).getByRole('button', { name: /Priority/ }));
    await user.click(await screen.findByRole('option', { name: /Urgent/ }));
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Search',
          health: 'on_track',
          priority: 'urgent',
          icon: expect.any(String) as unknown,
          color: expect.any(String) as unknown,
        })
      );
    });
  });

  it('does not offer creating to a guest with no team role', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    listTeams.mockResolvedValue([roleless(engine)]);
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    expect(screen.queryByRole('button', { name: 'New project' })).toBeNull();
  });

  it('offers creating on a writable team after a read-only one', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    listTeams.mockResolvedValue([
      roleless(engine),
      { ...design, role: 'member' },
    ]);
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'New project' })
    ).toBeInTheDocument();
  });

  describe('with a sub-team', () => {
    /** Design as a sub-team of Engine. */
    const designUnderEngine: TeamRead = { ...design, parent_team_id: 'team-1' };

    beforeEach(() => {
      listTeams.mockResolvedValue([engine, designUnderEngine]);
      listProjects.mockImplementation((query) =>
        Promise.resolve({
          projects:
            query.include_sub_teams === true ? [launch, rebrand] : [launch],
          next_cursor: null,
        })
      );
    });

    it('rolls the sub-team projects into the parent team filter', async () => {
      renderPage('/w/mine/projects?team=ENG');

      expect(
        await screen.findByRole('link', { name: 'Rebrand' })
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Launch' })).toBeInTheDocument();
      expect(listProjects).toHaveBeenCalledWith({
        team_id: 'team-1',
        include_sub_teams: true,
      });
      expect(
        screen.getByRole('button', { name: 'Including sub-teams' })
      ).toHaveAttribute('aria-pressed', 'true');
    });

    it('narrows to the team alone from the toggle', async () => {
      const user = userEvent.setup();
      renderPage('/w/mine/projects?team=ENG');

      await screen.findByRole('link', { name: 'Rebrand' });
      await user.click(
        screen.getByRole('button', { name: 'Including sub-teams' })
      );

      await waitFor(() => {
        expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
      });
      expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-1' });
      expect(
        screen.getByRole('button', { name: 'This team only' })
      ).toHaveAttribute('aria-pressed', 'false');
    });

    it('offers no toggle on the sub-team itself', async () => {
      renderPage('/w/mine/projects?team=DES');

      await waitFor(() => {
        expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-2' });
      });
      expect(screen.queryByTestId('sub-team-roll-up')).toBeNull();
    });
  });
});
