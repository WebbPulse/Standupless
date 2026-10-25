/**
 * The workspace projects list. Covers that it reads every project the caller
 * can see in one cursor walk, groups them by status, narrows by team and
 * status from the URL, links each row to its project, edits the status and
 * health in place, draws each project's own icon, and only offers creating to a role that may write.
 * Filtered to a parent team, the list rolls in its sub-teams' projects until
 * the toggle narrows it to the team alone. The Display menu switches to a
 * board whose columns follow the grouping and take dropped cards, or to a
 * timeline; groups by health or priority; and hides completed projects
 * outside the chosen window. The Display menu also hides and shows list
 * columns, reverses the groups, groups again inside each group, keeps only
 * the projects a filtered team leads, and drops empty board columns, and the
 * blocked and blocking filters narrow the rows. Save as view stores the filters and the
 * arrangement as a view of projects and opens it. A board card edits its
 * properties in place and from its context menu, a column header menu hides,
 * collapses and isolates its column, and a drop into a swimlane changes both
 * the column and the lane field. The page opens with the team's or the
 * workspace's default for everyone, which only an admin of that scope sets or
 * clears from the Display menu. Columns join the list in priority order as it
 * widens, and a row whose name is cut off reveals it in a tooltip.
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
  ProjectUpdate,
  ProjectsDisplayPreference,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import type { SavedViewDisplayRead } from '../../api/views';
import type {
  TeamDisplayDefaultsRead,
  TeamDisplayDefaultsUpdate,
  WorkspaceDisplayDefaultsRead,
} from '../../api/teams';
import { DEFAULT_PROJECTS_DISPLAY } from '../../lib/projectList';
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
const createView =
  vi.fn<(body: Record<string, unknown>) => Promise<SavedViewDisplayRead>>();

vi.mock('../../api/projectLabels', () => ({
  projectLabelsPath: (workspaceId: string) =>
    `/workspaces/${workspaceId}/project-labels`,
  listProjectLabels: () => Promise.resolve([]),
  createProjectLabel: vi.fn(),
  updateProjectLabel: vi.fn(),
  deleteProjectLabel: vi.fn(),
}));

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    createView: (_w: string, body: Record<string, unknown>) => createView(body),
  };
});

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

const getDisplayDefaults = vi.fn<() => Promise<TeamDisplayDefaultsRead>>();
const updateDisplayDefaults =
  vi.fn<
    (teamId: string, body: TeamDisplayDefaultsUpdate) => Promise<unknown>
  >();
const getWorkspaceDisplayDefaults =
  vi.fn<() => Promise<WorkspaceDisplayDefaultsRead>>();
const updateWorkspaceDisplayDefaults =
  vi.fn<(display: ProjectsDisplayPreference | null) => Promise<unknown>>();

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  getDisplayDefaults: () => getDisplayDefaults(),
  updateDisplayDefaults: (
    _w: string,
    teamId: string,
    body: TeamDisplayDefaultsUpdate
  ) => updateDisplayDefaults(teamId, body),
  getWorkspaceDisplayDefaults: () => getWorkspaceDisplayDefaults(),
  updateWorkspaceDisplayDefaults: (
    _w: string,
    display: ProjectsDisplayPreference | null
  ) => updateWorkspaceDisplayDefaults(display),
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

vi.mock('../../api/notifications', () => ({
  updatePreferences: vi.fn(() => Promise.resolve({})),
}));

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

/** The built-in arrangement as the display defaults routes answer it. */
const BUILT_IN =
  DEFAULT_PROJECTS_DISPLAY as unknown as ProjectsDisplayPreference;

/** The board, as an admin saved it for everyone. */
const BOARD = {
  ...BUILT_IN,
  layout: 'board',
} as ProjectsDisplayPreference;

/** A team's display defaults, with the projects page default given. */
const teamDefaults = (
  own: ProjectsDisplayPreference | null,
  effective: ProjectsDisplayPreference = own ?? BUILT_IN
): TeamDisplayDefaultsRead => ({
  team_id: 'team-1',
  list_display: null,
  board_display: null,
  projects_display: own,
  effective_projects_display: effective,
  updated_by: null,
  updated_at: null,
});

/** The workspace's display defaults, with the projects page default given. */
const workspaceDefaults = (
  own: ProjectsDisplayPreference | null
): WorkspaceDisplayDefaultsRead => ({
  projects_display: own,
  effective_projects_display: own ?? BUILT_IN,
  updated_by: null,
  updated_at: null,
});

const renderPage = (entry = '/w/mine/projects') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/projects" element={<Projects />} />
        <Route path="/w/:slug/projects/:id" element={<p>project page</p>} />
        <Route path="/w/:slug/views/:viewId" element={<p>view page</p>} />
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
    getDisplayDefaults.mockResolvedValue(teamDefaults(null));
    getWorkspaceDisplayDefaults.mockResolvedValue(workspaceDefaults(null));
    updateDisplayDefaults.mockResolvedValue({});
    updateWorkspaceDisplayDefaults.mockResolvedValue({});
  });

  it('opens with the workspace default for everyone', async () => {
    getWorkspaceDisplayDefaults.mockResolvedValue(workspaceDefaults(BOARD));
    renderPage();

    expect(
      await screen.findByRole('list', { name: 'Backlog projects' })
    ).toBeInTheDocument();
  });

  it('opens a team page with the default its team falls back to', async () => {
    getDisplayDefaults.mockResolvedValue(teamDefaults(null, BOARD));
    renderPage('/w/mine/projects?team=ENG');

    expect(
      await screen.findByRole('list', { name: 'Backlog projects' })
    ).toBeInTheDocument();
    expect(getWorkspaceDisplayDefaults).not.toHaveBeenCalled();
  });

  it('lets a workspace admin set the default for everyone', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(
      await screen.findByRole('button', { name: 'Set default for everyone' })
    );

    await waitFor(() => {
      expect(updateWorkspaceDisplayDefaults).toHaveBeenCalledWith(
        expect.objectContaining({ layout: 'list', group: 'status' })
      );
    });
  });

  it('lets a team admin clear the team default', async () => {
    getDisplayDefaults.mockResolvedValue(teamDefaults(BOARD));
    const user = userEvent.setup();
    renderPage('/w/mine/projects?team=ENG');

    await screen.findByRole('list', { name: 'Backlog projects' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(
      await screen.findByRole('button', { name: 'Clear default' })
    );

    await waitFor(() => {
      expect(updateDisplayDefaults).toHaveBeenCalledWith('team-1', {
        projects_display: null,
      });
    });
  });

  it('offers a member no default for everyone', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    await user.click(screen.getByRole('button', { name: 'Display' }));

    expect(
      screen.queryByRole('button', { name: 'Set default for everyone' })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear default' })).toBeNull();
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

  it('hides a column turned off in the Display menu and shows issues turned on', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findAllByRole('button', { name: 'Health: No updates' })
    ).toHaveLength(2);
    expect(screen.queryByText('2 of 4 issues done')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Display' }));
    const health = screen.getByRole('button', { name: 'Health' });
    expect(health).toHaveAttribute('aria-pressed', 'true');
    await user.click(health);
    await user.click(screen.getByRole('button', { name: 'Issues' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Health: No updates' })
      ).toBeNull();
    });
    expect(screen.getAllByText('2 of 4 issues done')).toHaveLength(2);
  });

  it('reads the shown columns from the URL', async () => {
    renderPage('/w/mine/projects?columns=status,progress');

    await screen.findByRole('link', { name: 'Launch' });
    expect(
      screen.queryByRole('button', { name: 'Health: No updates' })
    ).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lead: No lead' })).toBeNull();
  });

  it('narrows to blocked and blocking projects from the URL', async () => {
    listProjects.mockResolvedValue({
      projects: [
        { ...launch, blocking_project_ids: ['prj-2'] },
        { ...rebrand, blocked_by_project_ids: ['prj-1'] },
      ],
      next_cursor: null,
    });
    const { unmount } = renderPage('/w/mine/projects?blocked=true');

    expect(
      await screen.findByRole('link', { name: 'Rebrand' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Launch' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Blocked filter: Yes' })
    ).toBeInTheDocument();
    unmount();

    renderPage('/w/mine/projects?blocking=true');
    expect(
      await screen.findByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
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

  it('edits the start and target dates from the row', async () => {
    const user = userEvent.setup();
    updateProject.mockResolvedValue({ ...launch, target_date: null });
    renderPage();

    expect(
      await screen.findAllByRole('button', { name: 'Start date: No date' })
    ).toHaveLength(2);
    const [target] = screen.getAllByRole('button', {
      name: /^Target date: /,
    });
    if (target === undefined) throw new Error('no target control');
    await user.click(target);
    await user.click(await screen.findByRole('option', { name: /Clear date/ }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        target_date: null,
      });
    });
  });

  it('flags a blocked project and the project blocking it', async () => {
    listProjects.mockResolvedValue({
      projects: [
        { ...launch, blocked_by_project_ids: ['prj-2'] },
        { ...rebrand, blocking_project_ids: ['prj-1'] },
      ],
      next_cursor: null,
    });
    renderPage();

    expect(
      await screen.findByRole('img', { name: 'Blocked by 1 open project' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Blocking 1 project' })
    ).toBeInTheDocument();
  });

  it('drops the blocked flag once the blocker is completed', async () => {
    listProjects.mockResolvedValue({
      projects: [
        { ...launch, blocked_by_project_ids: ['prj-2'] },
        {
          ...rebrand,
          status: 'completed',
          blocking_project_ids: ['prj-1'],
        },
      ],
      next_cursor: null,
    });
    renderPage('/w/mine/projects?closed=all');

    await screen.findByRole('link', { name: 'Launch' });
    expect(
      screen.queryByRole('img', { name: /Blocked by/ })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: /Blocking/ })
    ).not.toBeInTheDocument();
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

  it('hides the lower value columns first as the list narrows', async () => {
    renderPage('/w/mine/projects?columns=status,start,created,progress');

    await screen.findByRole('link', { name: 'Launch' });
    const header = screen.getByText('Name').parentElement;
    if (header === null) throw new Error('no header');
    expect(within(header).getByText('Status')).toHaveClass(
      'hidden',
      '@min-[40rem]:block'
    );
    expect(within(header).getByText('Start')).toHaveClass(
      'hidden',
      '@min-[72rem]:block'
    );
    expect(within(header).getByText('Created')).toHaveClass(
      'hidden',
      '@min-[96rem]:block'
    );
    expect(header.style.getPropertyValue('--project-columns-md')).toBe(
      'minmax(16rem,1fr) 8.5rem 4.5rem'
    );
  });

  it('shows the full name in a tooltip when the row cuts it off', async () => {
    renderPage();

    const link = await screen.findByRole('link', { name: 'Launch' });
    const row = link.closest('li');
    if (row === null) throw new Error('no row');
    const name = within(row).getByText('Launch', { selector: 'span' });
    Object.defineProperty(name, 'scrollWidth', {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(name, 'clientWidth', {
      configurable: true,
      value: 120,
    });
    name.getBoundingClientRect = () => new DOMRect(0, 0, 120, 20);

    fireEvent.mouseMove(link, { clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(
        screen
          .queryAllByRole('tooltip', { hidden: true })
          .map((tip) => tip.textContent)
      ).toContain('Launch');
    });
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

  it('switches to a board with a column per status from the Display menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('radio', { name: 'Board' }));

    const backlog = await screen.findByRole('list', {
      name: 'Backlog projects',
    });
    expect(within(backlog).queryAllByRole('listitem')).toHaveLength(0);
    expect(
      within(
        screen.getByRole('list', { name: 'In progress projects' })
      ).getByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
  });

  it('moves a project by dropping its card in another column', async () => {
    updateProject.mockResolvedValue({
      ...launch,
      status: 'paused',
      updated_at: '2026-09-19T00:00:00Z',
    });
    renderPage('/w/mine/projects?layout=board');

    const link = await screen.findByRole('link', { name: 'Launch' });
    const card = link.closest('li');
    if (card === null) throw new Error('no card');
    const data = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(card, { dataTransfer: data });
    const paused = screen.getByRole('list', { name: 'Paused projects' });
    fireEvent.dragOver(paused, { dataTransfer: data });
    fireEvent.drop(paused, { dataTransfer: data });

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        status: 'paused',
      });
    });
    expect(
      within(paused).getByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
  });

  it('asks about open issues before a drop completes a project', async () => {
    renderPage('/w/mine/projects?layout=board');

    const link = await screen.findByRole('link', { name: 'Launch' });
    const card = link.closest('li');
    if (card === null) throw new Error('no card');
    const data = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(card, { dataTransfer: data });
    const completed = screen.getByRole('list', { name: 'Completed projects' });
    fireEvent.dragOver(completed, { dataTransfer: data });
    fireEvent.drop(completed, { dataTransfer: data });

    expect(
      await screen.findByRole('button', { name: 'Complete project' })
    ).toBeInTheDocument();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('edits a card property in place from its picker', async () => {
    const user = userEvent.setup();
    updateProject.mockResolvedValue({
      ...launch,
      priority: 'high',
      updated_at: '2026-09-19T00:00:00Z',
    });
    renderPage('/w/mine/projects?layout=board');

    const link = await screen.findByRole('link', { name: 'Launch' });
    const card = link.closest('li');
    if (card === null) throw new Error('no card');
    await user.click(within(card).getByRole('button', { name: /^Priority: / }));
    await user.click(await screen.findByRole('option', { name: /^High/ }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        priority: 'high',
      });
    });
  });

  it('opens a hidden property picker from the card menu', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/projects?layout=board');

    const link = await screen.findByRole('link', { name: 'Launch' });
    const card = link.closest('li');
    if (card === null) throw new Error('no card');
    expect(
      within(card).queryByRole('button', { name: /^Members: / })
    ).toBeNull();
    fireEvent.contextMenu(card);
    const menu = screen.getByRole('menu', { name: 'Launch actions' });
    expect(
      within(menu).getByRole('menuitem', { name: 'Open project' })
    ).toBeInTheDocument();
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Change members' })
    );

    await waitFor(() => {
      expect(
        within(card).getByRole('button', { name: /^Members: / })
      ).toHaveAttribute('aria-expanded', 'true');
    });
  });

  it('hides, restores and collapses a column from its header menu', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/projects?layout=board');

    await screen.findByRole('list', { name: 'Paused projects' });
    await user.click(
      screen.getByRole('button', { name: 'Paused column options' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Hide column' }));

    expect(screen.queryByRole('list', { name: 'Paused projects' })).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    await user.click(within(rail).getByRole('button', { name: 'Show Paused' }));
    expect(
      screen.getByRole('list', { name: 'Paused projects' })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Paused column options' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Collapse column' }));
    expect(
      screen.getByRole('group', { name: 'Paused projects' })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Expand Paused column' })
    );
    expect(
      screen.getByRole('list', { name: 'Paused projects' })
    ).toBeInTheDocument();
  });

  it('shows only one column from its header menu', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/projects?layout=board');

    await screen.findByRole('list', { name: 'Planned projects' });
    await user.click(
      screen.getByRole('button', { name: 'Planned column options' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Show only this column' })
    );

    expect(
      screen.getByRole('list', { name: 'Planned projects' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'In progress projects' })
    ).toBeNull();
  });

  it('draws swimlanes and changes both fields on a drop into a lane', async () => {
    listProjects.mockResolvedValue({
      projects: [launch, { ...rebrand, priority: 'high' }],
      next_cursor: null,
    });
    updateProject.mockResolvedValue({
      ...launch,
      status: 'paused',
      priority: 'high',
      updated_at: '2026-09-19T00:00:00Z',
    });
    renderPage('/w/mine/projects?layout=board&rows=priority');

    const link = await screen.findByRole('link', { name: 'Launch' });
    expect(screen.getByRole('region', { name: 'High' })).toBeInTheDocument();
    const card = link.closest('li');
    if (card === null) throw new Error('no card');
    const data = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(card, { dataTransfer: data });
    const cell = screen.getByRole('list', { name: 'Paused, High projects' });
    fireEvent.dragOver(cell, { dataTransfer: data });
    fireEvent.drop(cell, { dataTransfer: data });

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        status: 'paused',
        priority: 'high',
      });
    });
  });

  it('draws the timeline layout from the URL', async () => {
    renderPage('/w/mine/projects?layout=timeline');

    expect(await screen.findByTestId('projects-timeline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
  });

  describe('timeline dependency lines', () => {
    beforeEach(() => {
      listProjects.mockResolvedValue({
        projects: [
          {
            ...launch,
            start_date: '2026-09-01',
            blocking_project_ids: ['prj-2'],
          },
          {
            ...rebrand,
            start_date: '2026-10-15',
            blocked_by_project_ids: ['prj-1'],
          },
        ],
        next_cursor: null,
      });
    });

    const drawn = (): Element | null =>
      document.querySelector('[data-dependency="prj-1:prj-2"]');

    it('hides and shows the lines from the Display menu', async () => {
      const user = userEvent.setup();
      renderPage('/w/mine/projects?layout=timeline');
      await screen.findByTestId('projects-timeline');
      await waitFor(() => {
        expect(drawn()).not.toBeNull();
      });

      await user.click(screen.getByRole('button', { name: 'Display' }));
      const toggle = screen.getByRole('switch', { name: 'Show dependencies' });
      expect(toggle).toBeChecked();
      await user.click(toggle);

      expect(drawn()).toBeNull();
      expect(document.querySelector('[data-link-handle]')).toBeNull();

      await user.click(toggle);
      expect(drawn()).not.toBeNull();
      expect(document.querySelector('[data-link-handle]')).not.toBeNull();
    });

    it('draws no lines when the URL hides them', async () => {
      renderPage('/w/mine/projects?layout=timeline&dependencies=hide');
      await screen.findByTestId('projects-timeline');
      await screen.findAllByRole('link', { name: 'Launch' });

      expect(drawn()).toBeNull();
      expect(document.querySelector('[data-link-handle]')).toBeNull();
    });

    it('offers the switch only on the timeline layout', async () => {
      const user = userEvent.setup();
      renderPage('/w/mine/projects');
      await screen.findByRole('link', { name: 'Launch' });

      await user.click(screen.getByRole('button', { name: 'Display' }));
      expect(
        screen.queryByRole('switch', { name: 'Show dependencies' })
      ).toBeNull();
    });
  });

  it('groups by health and priority from the URL', async () => {
    listProjects.mockResolvedValue({
      projects: [launch, { ...rebrand, health: 'at_risk', priority: 'high' }],
      next_cursor: null,
    });
    const { unmount } = renderPage('/w/mine/projects?group=health');

    expect(
      within(await screen.findByRole('region', { name: 'At risk' })).getByRole(
        'link',
        { name: 'Rebrand' }
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'No updates' })).getByRole(
        'link',
        { name: 'Launch' }
      )
    ).toBeInTheDocument();
    unmount();

    renderPage('/w/mine/projects?group=priority');
    expect(
      within(await screen.findByRole('region', { name: 'High' })).getByRole(
        'link',
        { name: 'Rebrand' }
      )
    ).toBeInTheDocument();
  });

  it('hides completed projects when the window says none', async () => {
    const shipped = {
      ...rebrand,
      project_id: 'prj-5',
      name: 'Shipped',
      status: 'completed' as const,
      completed_at: '2026-01-01T00:00:00Z',
    };
    listProjects.mockResolvedValue({
      projects: [launch, shipped],
      next_cursor: null,
    });
    renderPage('/w/mine/projects?closed=none');

    await screen.findByRole('link', { name: 'Launch' });
    expect(screen.queryByRole('link', { name: 'Shipped' })).toBeNull();
  });

  it('saves the filters and arrangement as a view of projects', async () => {
    const user = userEvent.setup();
    createView.mockResolvedValue({
      view_id: 'view-9',
      name: 'Planned board',
    } as SavedViewDisplayRead);
    renderPage('/w/mine/projects?status=planned&layout=board');

    await screen.findByRole('link', { name: 'Rebrand' });
    await user.click(screen.getByRole('button', { name: 'Save as view' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('View name'),
      'Planned board'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(createView).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Planned board',
          entity: 'projects',
          filter: { status: ['planned'] },
          projects_display: expect.objectContaining({
            layout: 'board',
          }) as unknown,
        })
      );
    });
    expect(await screen.findByText('view page')).toBeInTheDocument();
  });

  it('reverses the groups from the Display menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    const order = (): string[] =>
      screen
        .getAllByRole('region')
        .map((region) => region.getAttribute('aria-label') ?? '')
        .filter((name) => name === 'Planned' || name === 'In progress');
    const before = order();
    expect(before).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('button', { name: 'Reverse grouping' }));

    expect(order()).toEqual([...before].reverse());
  });

  it('groups again inside each group from the URL', async () => {
    listProjects.mockResolvedValue({
      projects: [launch, { ...rebrand, team_ids: ['team-2'] }],
      next_cursor: null,
    });
    renderPage('/w/mine/projects?rows=team');

    const nested = await screen.findByRole('region', {
      name: 'In progress, Engine',
    });
    expect(
      within(nested).getByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Planned, Design' })).getByRole(
        'link',
        { name: 'Rebrand' }
      )
    ).toBeInTheDocument();
  });

  it('keeps only the projects a filtered team leads when asked', async () => {
    const user = userEvent.setup();
    listProjects.mockResolvedValue({
      projects: [launch, { ...rebrand, team_ids: ['team-1', 'team-2'] }],
      next_cursor: null,
    });
    renderPage('/w/mine/projects?team=ENG');

    await screen.findByRole('link', { name: 'Rebrand' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(
      screen.getByRole('switch', { name: 'Only show lead team projects' })
    );

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
    });
    expect(screen.getByRole('link', { name: 'Launch' })).toBeInTheDocument();
  });

  it('offers the lead team switch only with a team filter', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    await user.click(screen.getByRole('button', { name: 'Display' }));

    expect(
      screen.queryByRole('switch', { name: 'Only show lead team projects' })
    ).toBeNull();
  });

  it('drops empty board columns from the Display menu', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/projects?layout=board');

    await screen.findByRole('list', { name: 'Backlog projects' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(
      screen.getByRole('switch', { name: 'Show empty columns' })
    );

    await waitFor(() => {
      expect(
        screen.queryByRole('list', { name: 'Backlog projects' })
      ).toBeNull();
    });
    expect(
      screen.getByRole('list', { name: 'In progress projects' })
    ).toBeInTheDocument();
  });

  it('hides canceled and long completed projects by default, on a team page too', async () => {
    const daysAgo = (days: number): string =>
      new Date(Date.now() - days * 86400000).toISOString();
    listProjects.mockResolvedValue({
      projects: [
        launch,
        {
          ...rebrand,
          status: 'canceled',
          completed_at: daysAgo(1),
          team_ids: ['team-1'],
        },
        {
          ...rebrand,
          project_id: 'prj-6',
          name: 'Shipped',
          status: 'completed',
          completed_at: daysAgo(3),
          team_ids: ['team-1'],
        },
        {
          ...rebrand,
          project_id: 'prj-7',
          name: 'Archived',
          status: 'completed',
          completed_at: daysAgo(40),
          team_ids: ['team-1'],
        },
      ],
      next_cursor: null,
    });
    const { unmount } = renderPage();

    expect(await screen.findByRole('link', { name: 'Shipped' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Archived' })).toBeNull();
    unmount();

    renderPage('/w/mine/projects?team=ENG');
    expect(await screen.findByRole('link', { name: 'Shipped' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
  });

  it('hides closed projects from the Display menu', async () => {
    const user = userEvent.setup();
    listProjects.mockResolvedValue({
      projects: [
        launch,
        {
          ...rebrand,
          status: 'completed',
          completed_at: new Date().toISOString(),
        },
      ],
      next_cursor: null,
    });
    renderPage();

    await screen.findByRole('link', { name: 'Rebrand' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.selectOptions(
      screen.getByLabelText('Show closed projects'),
      'none'
    );

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Rebrand' })).toBeNull();
    });
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
