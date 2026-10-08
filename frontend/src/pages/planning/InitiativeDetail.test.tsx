/**
 * One initiative's page. Covers that it reads the initiative from the id and
 * rolls up its projects' progress and health, that a status change is written
 * in place, that a project is added from the picker and removed from its row,
 * that deleting is offered to an admin and returns to the list, and that the
 * updates tab speaks of an initiative rather than a project.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  InitiativeRead,
  InitiativeUpdate,
  MemberRead,
  ProjectListRead,
  ProjectRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import InitiativeDetail from './InitiativeDetail';

const getInitiative = vi.fn<() => Promise<InitiativeRead>>();
const updateInitiative =
  vi.fn<(body: InitiativeUpdate) => Promise<InitiativeRead>>();
const deleteInitiative = vi.fn<() => Promise<void>>();
const addInitiativeProject = vi.fn<(id: string) => Promise<ProjectRead>>();
const removeInitiativeProject = vi.fn<(id: string) => Promise<ProjectRead>>();
const listProjects = vi.fn<() => Promise<ProjectListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: {
      id: 'user-2',
      email: 'grace@example.com',
      display_name: 'Grace Hopper',
    },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/initiatives', () => ({
  getInitiative: () => getInitiative(),
  updateInitiative: (_w: string, _id: string, body: InitiativeUpdate) =>
    updateInitiative(body),
  deleteInitiative: () => deleteInitiative(),
  addInitiativeProject: (_w: string, _i: string, id: string) =>
    addInitiativeProject(id),
  removeInitiativeProject: (_w: string, _i: string, id: string) =>
    removeInitiativeProject(id),
  listInitiatives: () =>
    Promise.resolve({ initiatives: [], next_cursor: null }),
  listInitiativeUpdates: () =>
    Promise.resolve({ updates: [], next_cursor: null }),
  createInitiativeUpdate: vi.fn(),
  updateInitiativeUpdate: vi.fn(),
  deleteInitiativeUpdate: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => listProjects(),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listTeamMembers: () => Promise.resolve([]),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
}));

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return { ...actual, listMembers: () => listMembers() };
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

/** The team every project is on. */
const engine: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

/** Builds a project on the team. */
const project = (
  id: string,
  name: string,
  overrides: Partial<ProjectRead> = {}
): ProjectRead => ({
  project_id: id,
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: null,
  name,
  description: null,
  target_date: null,
  status: 'in_progress',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts: { todo: 1, in_progress: 0, done: 1, cancelled: 0, total: 2 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  ...overrides,
});

/** The initiative the page reads, holding one project. */
const grow: InitiativeRead = {
  initiative_id: 'ini-1',
  workspace_id: 'ws-1',
  name: 'Grow',
  description: 'Double the users',
  owner_id: null,
  status: 'active',
  health: 'on_track',
  target_date: '2026-12-01',
  project_ids: ['prj-1'],
  project_count: 1,
  counts: { todo: 1, in_progress: 1, done: 2, cancelled: 0, total: 4 },
  points: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  project_health: { on_track: 1, at_risk: 2, off_track: 0, none: 0 },
  last_update_at: null,
  update_interval_days: 7,
  update_interval_inherited: true,
  next_update_due_at: null,
  update_due_state: null,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
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

const renderPage = (entry = '/w/mine/initiatives/ini-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/initiatives/:id" element={<InitiativeDetail />} />
        <Route path="/w/:slug/initiatives" element={<p>initiatives list</p>} />
      </Routes>
    </MemoryRouter>
  );

describe('InitiativeDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    getInitiative.mockResolvedValue(grow);
    listTeams.mockResolvedValue([engine]);
    listMembers.mockResolvedValue([]);
    listProjects.mockResolvedValue({
      projects: [
        project('prj-1', 'Launch', { initiative_id: 'ini-1' }),
        project('prj-2', 'Search'),
      ],
      next_cursor: null,
    });
  });

  it('rolls up the projects progress and health', async () => {
    renderPage();

    expect(await screen.findByText('Double the users')).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'Initiatives' })[0]
    ).toHaveAttribute('href', '/w/mine/initiatives');
    const panel = screen.getByRole('complementary', { name: 'Progress' });
    expect(within(panel).getByText('50% complete')).toBeInTheDocument();
    const atRisk = within(panel).getByText('At risk').closest('li');
    expect(atRisk).toHaveTextContent('2');
    const projects = screen.getByRole('region', { name: 'Projects' });
    expect(
      await within(projects).findByRole('link', { name: 'Launch' })
    ).toHaveAttribute('href', '/w/mine/projects/prj-1');
    expect(within(projects).queryByText('Search')).not.toBeInTheDocument();
  });

  it('writes a status change in place', async () => {
    updateInitiative.mockResolvedValue({ ...grow, status: 'completed' });
    const user = userEvent.setup();
    renderPage();

    const row = await screen.findByRole('group', { name: 'Properties' });
    await user.click(within(row).getByRole('button', { name: /^Status: / }));
    await user.click(await screen.findByRole('option', { name: /Completed/ }));

    await waitFor(() => {
      expect(updateInitiative).toHaveBeenCalledWith({ status: 'completed' });
    });
  });

  it('adds a project from the picker and removes one from its row', async () => {
    addInitiativeProject.mockResolvedValue(
      project('prj-2', 'Search', { initiative_id: 'ini-1' })
    );
    removeInitiativeProject.mockResolvedValue(project('prj-1', 'Launch'));
    const user = userEvent.setup();
    renderPage();

    const projects = await screen.findByRole('region', { name: 'Projects' });
    await user.click(
      await within(projects).findByRole('button', { name: 'Add project' })
    );
    await user.click(await screen.findByRole('option', { name: /Search/ }));
    await waitFor(() => {
      expect(addInitiativeProject).toHaveBeenCalledWith('prj-2');
    });

    await user.click(
      within(projects).getByRole('button', { name: 'Remove Launch' })
    );
    await waitFor(() => {
      expect(removeInitiativeProject).toHaveBeenCalledWith('prj-1');
    });
  });

  it('offers delete to an admin and returns to the list', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    deleteInitiative.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Initiative actions' })
    );
    await user.click(
      await screen.findByRole('menuitem', { name: /Delete initiative/ })
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete initiative' })
    );

    expect(await screen.findByText('initiatives list')).toBeInTheDocument();
    expect(deleteInitiative).toHaveBeenCalled();
  });

  it('hides delete from a member who neither made nor owns it', async () => {
    renderPage();

    await screen.findByText('Double the users');
    expect(
      screen.queryByRole('button', { name: 'Initiative actions' })
    ).not.toBeInTheDocument();
  });

  it('opens the updates tab for the initiative', async () => {
    renderPage('/w/mine/initiatives/ini-1?tab=updates');

    expect(await screen.findByRole('tab', { name: 'Updates' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(
      await screen.findByText(
        'No updates yet. Share how the initiative is going and whether it is on track.'
      )
    ).toBeInTheDocument();
  });
});
