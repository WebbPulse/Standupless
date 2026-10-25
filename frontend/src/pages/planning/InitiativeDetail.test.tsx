/**
 * One initiative's page. Covers that it reads the initiative from the id and
 * rolls up its projects' progress and health, that a status change is written
 * in place, that a project is added from the picker and removed from its row,
 * that deleting is offered to an admin and returns to the list, that the
 * updates tab speaks of an initiative rather than a project, and that
 * sub-initiatives show as breadcrumbs, a parent picker, a list of children,
 * rolled-up projects and a progress graph, and that the Projects tab lays the
 * initiative's projects out through the projects page, with or without the
 * projects of sub-initiatives, and that the page's keys open the status,
 * owner, health, start date and target date pickers, rename it, copy its
 * address and start an update.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  InitiativeProgressRead,
  InitiativeRead,
  InitiativeUpdate,
  MemberRead,
  ProjectListRead,
  ProjectRead,
  PulseFollowRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import { initiativePath } from '../../lib/paths';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import InitiativeDetail from './InitiativeDetail';

const getInitiative = vi.fn<() => Promise<InitiativeRead>>();
const listInitiatives =
  vi.fn<() => Promise<{ initiatives: InitiativeRead[]; next_cursor: null }>>();
const getInitiativeProgress = vi.fn<() => Promise<InitiativeProgressRead>>();
const updateInitiative =
  vi.fn<(body: InitiativeUpdate, id?: string) => Promise<InitiativeRead>>();
const deleteInitiative = vi.fn<() => Promise<void>>();
const addInitiativeProject = vi.fn<(id: string) => Promise<ProjectRead>>();
const removeInitiativeProject = vi.fn<(id: string) => Promise<ProjectRead>>();
const listProjects = vi.fn<() => Promise<ProjectListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const getFollow = vi.fn<() => Promise<PulseFollowRead>>();
const setFollow =
  vi.fn<
    (
      subject: string,
      id: string,
      following: boolean
    ) => Promise<PulseFollowRead>
  >();

vi.mock('../../api/views', async () => ({
  ...(await vi.importActual<typeof import('../../api/views')>(
    '../../api/views'
  )),
  listEntityReminders: () => Promise.resolve([]),
  setEntityReminder: vi.fn(),
  cancelEntityReminder: vi.fn(),
}));

vi.mock('../../api/pulse', () => ({
  getFollow: () => getFollow(),
  setFollow: (_w: string, subject: string, id: string, following: boolean) =>
    setFollow(subject, id, following),
}));

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

vi.mock('../../api/documents', () => ({
  listDocuments: () => Promise.resolve([]),
  listIssueDocuments: () => Promise.resolve([]),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

vi.mock('../../api/initiatives', () => ({
  getInitiative: () => getInitiative(),
  updateInitiative: (_w: string, id: string, body: InitiativeUpdate) =>
    updateInitiative(body, id),
  getInitiativeProgress: () => getInitiativeProgress(),
  deleteInitiative: () => deleteInitiative(),
  addInitiativeProject: (_w: string, _i: string, id: string) =>
    addInitiativeProject(id),
  removeInitiativeProject: (_w: string, _i: string, id: string) =>
    removeInitiativeProject(id),
  listInitiatives: () => listInitiatives(),
  listInitiativeUpdates: () =>
    Promise.resolve({ updates: [], next_cursor: null }),
  createInitiativeUpdate: vi.fn(),
  updateInitiativeUpdate: vi.fn(),
  deleteInitiativeUpdate: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => listProjects(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock('../../api/projectStatuses', () => ({
  projectStatusesPath: (workspaceId: string) =>
    `/workspaces/${workspaceId}/project-statuses`,
  listProjectStatuses: () => Promise.resolve([]),
  createProjectStatus: vi.fn(),
  updateProjectStatus: vi.fn(),
  deleteProjectStatus: vi.fn(),
}));

vi.mock('../../api/projectLabels', () => ({
  projectLabelsPath: (workspaceId: string) =>
    `/workspaces/${workspaceId}/project-labels`,
  listProjectLabels: () => Promise.resolve([]),
  createProjectLabel: vi.fn(),
  updateProjectLabel: vi.fn(),
  deleteProjectLabel: vi.fn(),
}));

vi.mock('../../api/customers', async () => {
  const actual = await vi.importActual<typeof import('../../api/customers')>(
    '../../api/customers'
  );
  return {
    ...actual,
    listCustomers: () => Promise.resolve([]),
  };
});

vi.mock('../../api/notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/notifications')
  >('../../api/notifications');
  return { ...actual, updatePreferences: vi.fn(() => Promise.resolve({})) };
});

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
    getFollow.mockResolvedValue({ following: false, explicit: false });
    listInitiatives.mockResolvedValue({
      initiatives: [grow],
      next_cursor: null,
    });
    getInitiativeProgress.mockResolvedValue({
      initiative_id: 'ini-1',
      measure: 'issues',
      start_date: '2026-10-01',
      end_date: '2026-10-03',
      days: [
        { date: '2026-10-01', scope: 2, started: 0, completed: 0 },
        { date: '2026-10-02', scope: 3, started: 1, completed: 1 },
      ],
    });
  });

  it('follows the initiative in Pulse', async () => {
    const user = userEvent.setup();
    setFollow.mockResolvedValue({ following: true, explicit: true });
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Follow' }));

    expect(setFollow).toHaveBeenCalledWith('initiative', 'ini-1', true);
    expect(
      await screen.findByRole('button', { name: 'Following' })
    ).toHaveAttribute('aria-pressed', 'true');
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
      expect(updateInitiative).toHaveBeenCalledWith(
        { status: 'completed' },
        'ini-1'
      );
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
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Double the users');
    await user.click(
      screen.getByRole('button', { name: 'Initiative actions' })
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Remind me…' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: /Delete initiative/ })
    ).toBeNull();
  });

  it('opens the reminder dialog from its actions menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Double the users');
    await user.click(
      screen.getByRole('button', { name: 'Initiative actions' })
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Remind me…' })
    );

    expect(
      await screen.findByText(
        'Grow comes back to your inbox at the time you pick.'
      )
    ).toBeInTheDocument();
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

  describe('sub-initiatives', () => {
    const company: InitiativeRead = {
      ...grow,
      initiative_id: 'ini-0',
      name: 'Company goals',
      project_ids: [],
      sub_initiative_ids: ['ini-1'],
    };
    const nested: InitiativeRead = {
      ...grow,
      initiative_id: 'ini-1',
      parent_initiative_id: 'ini-0',
      ancestors: [{ initiative_id: 'ini-0', name: 'Company goals' }],
      sub_initiative_ids: ['ini-2'],
      rollup_project_ids: ['prj-1', 'prj-3'],
    };
    const europe: InitiativeRead = {
      ...grow,
      initiative_id: 'ini-2',
      name: 'Europe',
      parent_initiative_id: 'ini-1',
      project_ids: ['prj-3'],
    };
    const spare: InitiativeRead = {
      ...grow,
      initiative_id: 'ini-3',
      name: 'Hiring',
      project_ids: [],
    };

    beforeEach(() => {
      getInitiative.mockResolvedValue(nested);
      listInitiatives.mockResolvedValue({
        initiatives: [company, nested, europe, spare],
        next_cursor: null,
      });
      listProjects.mockResolvedValue({
        projects: [
          project('prj-1', 'Launch', { initiative_id: 'ini-1' }),
          project('prj-3', 'Berlin office', { initiative_id: 'ini-2' }),
        ],
        next_cursor: null,
      });
    });

    it('walks the breadcrumbs up to the parent', async () => {
      renderPage();

      expect(
        await screen.findByRole('link', { name: 'Company goals' })
      ).toHaveAttribute('href', '/w/mine/initiatives/ini-0');
      const row = screen.getByRole('group', { name: 'Properties' });
      expect(
        within(row).getByRole('button', { name: 'Parent: Company goals' })
      ).toBeInTheDocument();
    });

    it('lists its sub-initiatives and the projects they roll up', async () => {
      renderPage();

      const children = await screen.findByRole('region', {
        name: 'Sub-initiatives',
      });
      expect(
        await within(children).findByRole('link', { name: 'Europe' })
      ).toHaveAttribute('href', '/w/mine/initiatives/ini-2');
      const projects = screen.getByRole('region', { name: 'Projects' });
      expect(
        await within(projects).findByRole('link', { name: 'Berlin office' })
      ).toBeInTheDocument();
      expect(within(projects).getByText('via Europe')).toBeInTheDocument();
      expect(
        within(projects).queryByRole('button', { name: 'Remove Berlin office' })
      ).not.toBeInTheDocument();
    });

    it('detaches a sub-initiative from its row', async () => {
      updateInitiative.mockResolvedValue({
        ...europe,
        parent_initiative_id: null,
      });
      const user = userEvent.setup();
      renderPage();

      const children = await screen.findByRole('region', {
        name: 'Sub-initiatives',
      });
      await user.click(
        await within(children).findByRole('button', {
          name: 'Remove Europe from this initiative',
        })
      );

      await waitFor(() => {
        expect(updateInitiative).toHaveBeenCalledWith(
          { parent_initiative_id: null },
          'ini-2'
        );
      });
    });

    it('adopts an existing initiative as a sub-initiative', async () => {
      updateInitiative.mockResolvedValue({
        ...spare,
        parent_initiative_id: 'ini-1',
      });
      const user = userEvent.setup();
      renderPage();

      const children = await screen.findByRole('region', {
        name: 'Sub-initiatives',
      });
      await user.click(
        await within(children).findByRole('button', { name: 'Add existing' })
      );
      expect(
        screen.queryByRole('option', { name: /Company goals/ })
      ).not.toBeInTheDocument();
      await user.click(await screen.findByRole('option', { name: /Hiring/ }));

      await waitFor(() => {
        expect(updateInitiative).toHaveBeenCalledWith(
          { parent_initiative_id: 'ini-1' },
          'ini-3'
        );
      });
    });

    it('moves the initiative to the top level from the parent picker', async () => {
      updateInitiative.mockResolvedValue({
        ...nested,
        parent_initiative_id: null,
        ancestors: [],
      });
      const user = userEvent.setup();
      renderPage();

      const row = await screen.findByRole('group', { name: 'Properties' });
      await user.click(
        await within(row).findByRole('button', {
          name: 'Parent: Company goals',
        })
      );
      expect(
        screen.queryByRole('option', { name: /Europe/ })
      ).not.toBeInTheDocument();
      await user.click(
        await screen.findByRole('option', { name: /No parent/ })
      );

      await waitFor(() => {
        expect(updateInitiative).toHaveBeenCalledWith(
          { parent_initiative_id: null },
          'ini-1'
        );
      });
    });

    it('lays out the projects tab with sub-initiative projects by default', async () => {
      const user = userEvent.setup();
      renderPage('/w/mine/initiatives/ini-1?tab=projects');

      expect(
        await screen.findByRole('tab', { name: 'Projects' })
      ).toHaveAttribute('aria-selected', 'true');
      expect(
        await screen.findByRole('link', { name: 'Berlin office' })
      ).toHaveAttribute('href', '/w/mine/projects/prj-3');
      expect(screen.getByRole('link', { name: 'Launch' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Display' })
      ).toBeInTheDocument();

      await user.click(screen.getByTestId('sub-initiative-roll-up'));

      await waitFor(() => {
        expect(
          screen.queryByRole('link', { name: 'Berlin office' })
        ).not.toBeInTheDocument();
      });
      expect(screen.getByRole('link', { name: 'Launch' })).toBeInTheDocument();
      expect(screen.getByTestId('sub-initiative-roll-up')).toHaveTextContent(
        'This initiative only'
      );
    });

    it('adds a project from the projects tab', async () => {
      listProjects.mockResolvedValue({
        projects: [
          project('prj-1', 'Launch', { initiative_id: 'ini-1' }),
          project('prj-2', 'Search'),
        ],
        next_cursor: null,
      });
      addInitiativeProject.mockResolvedValue(
        project('prj-2', 'Search', { initiative_id: 'ini-1' })
      );
      const user = userEvent.setup();
      renderPage('/w/mine/initiatives/ini-1?tab=projects');

      expect(
        await screen.findByRole('link', { name: 'Launch' })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'Search' })
      ).not.toBeInTheDocument();
      await user.click(
        await screen.findByRole('button', { name: 'Add project' })
      );
      await user.click(await screen.findByRole('option', { name: /Search/ }));

      await waitFor(() => {
        expect(addInitiativeProject).toHaveBeenCalledWith('prj-2');
      });
    });

    it('draws the progress graph across the subtree', async () => {
      renderPage();

      expect(
        await screen.findByTestId('initiative-progress-graph')
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(getInitiativeProgress).toHaveBeenCalled();
      });
    });
  });

  describe('keyboard', () => {
    /** Renders the page inside a shortcut registry, as the workspace shell does. */
    const renderWithKeys = (entry = '/w/mine/initiatives/ini-1') =>
      render(
        <ShortcutProvider>
          <BoundKeys />
          <MemoryRouter initialEntries={[entry]}>
            <Routes>
              <Route
                path="/w/:slug/initiatives/:id"
                element={<InitiativeDetail />}
              />
            </Routes>
          </MemoryRouter>
        </ShortcutProvider>
      );

    /** Dispatches one key the way the shortcut layer listens for it. */
    const press = (key: string, init: KeyboardEventInit = {}) => {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, ...init })
        );
      });
    };

    it('binds the property keys on the overview', async () => {
      renderWithKeys();
      await screen.findByRole('group', { name: 'Properties' });

      await keysBound(
        's',
        'a',
        'h',
        'shift+s',
        'shift+d',
        'r',
        'mod+shift+,',
        'shift+u'
      );
    });

    it('opens the status picker on S and saves the choice', async () => {
      updateInitiative.mockResolvedValue({ ...grow, status: 'completed' });
      const user = userEvent.setup();
      renderWithKeys();
      await screen.findByRole('group', { name: 'Properties' });
      await keysBound('s');

      press('s');
      await user.click(
        await screen.findByRole('option', { name: /Completed/ })
      );

      await waitFor(() => {
        expect(updateInitiative).toHaveBeenCalledWith(
          { status: 'completed' },
          'ini-1'
        );
      });
    });

    it.each([
      ['a', {}, 'Owner'],
      ['h', {}, 'Health'],
      ['S', { shiftKey: true }, 'Start date'],
      ['D', { shiftKey: true }, 'Target date'],
    ])('opens a picker on %s', async (key, init, dialog) => {
      renderWithKeys();
      await screen.findByRole('group', { name: 'Properties' });
      await keysBound('a', 'h', 'shift+s', 'shift+d');

      press(key, init);

      expect(
        await screen.findByRole('dialog', { name: dialog })
      ).toBeInTheDocument();
    });

    it('focuses the name on R', async () => {
      renderWithKeys();
      const name = await screen.findByRole('textbox', {
        name: 'Initiative name',
      });
      await keysBound('r');

      press('r');

      expect(name).toHaveFocus();
    });

    it('copies the initiative URL on Cmd or Ctrl+Shift+,', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      renderWithKeys();
      await screen.findByRole('group', { name: 'Properties' });
      await keysBound('mod+shift+,');

      press('<', { ctrlKey: true, shiftKey: true, code: 'Comma' });

      expect(writeText).toHaveBeenCalledWith(
        `${globalThis.location.origin}${initiativePath('mine', grow)}`
      );
    });

    it('opens the update composer on Shift+U', async () => {
      renderWithKeys();
      await screen.findByRole('group', { name: 'Properties' });
      await keysBound('shift+u');

      press('U', { shiftKey: true });

      expect(
        await screen.findByRole('tab', { name: 'Updates' })
      ).toHaveAttribute('aria-selected', 'true');
      expect(
        await screen.findByText(
          'No updates yet. Share how the initiative is going and whether it is on track.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /Write an initiative update/ })
      ).not.toBeInTheDocument();
    });
  });
});
