/**
 * The roadmap. Covers that it draws each dated project as a bar over its
 * dates, lists an undated one without a bar, narrows to a team from the URL,
 * moves a bar a day with the arrow keys and writes the new dates, switches
 * zoom levels, and groups lanes under foldable headers. Also covers linking
 * projects by dragging from a bar's dot or from a focused bar's menu, the
 * server's refusal of a self link or a loop, hovering and removing a
 * dependency line, and the diamonds dated milestones draw on their lanes.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  ProjectListRead,
  ProjectRead,
  ProjectRelationCreate,
  ProjectRelationRead,
  ProjectUpdate,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Roadmap from './Roadmap';

const listProjects =
  vi.fn<
    (query: { team_id?: string; cursor?: string }) => Promise<ProjectListRead>
  >();
const updateProject =
  vi.fn<(id: string, patch: ProjectUpdate) => Promise<ProjectRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const createProjectRelation =
  vi.fn<
    (id: string, body: ProjectRelationCreate) => Promise<ProjectRelationRead>
  >();
const listProjectRelations =
  vi.fn<(id: string) => Promise<ProjectRelationRead[]>>();
const deleteProjectRelation =
  vi.fn<(id: string, relationId: string) => Promise<void>>();

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
  listProjects: (_w: string, query: { team_id?: string; cursor?: string }) =>
    listProjects(query),
  updateProject: (_w: string, id: string, patch: ProjectUpdate) =>
    updateProject(id, patch),
  createProjectRelation: (
    _w: string,
    id: string,
    body: ProjectRelationCreate
  ) => createProjectRelation(id, body),
  listProjectRelations: (_w: string, id: string) => listProjectRelations(id),
  deleteProjectRelation: (_w: string, id: string, relationId: string) =>
    deleteProjectRelation(id, relationId),
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
  start_date: '2026-09-20',
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

/** A project on the other team with no dates yet. */
const rebrand: ProjectRead = {
  ...launch,
  project_id: 'prj-2',
  team_id: 'team-2',
  name: 'Rebrand',
  start_date: null,
  target_date: null,
  status: 'planned',
};

/** A second dated project on the first team, after Launch. */
const ship: ProjectRead = {
  ...launch,
  project_id: 'prj-3',
  name: 'Ship',
  start_date: '2026-10-05',
  target_date: '2026-10-20',
};

/** One stored relation as the server lists it. */
const relation = (
  type: ProjectRelationRead['type'],
  projectId: string,
  targetId: string
): ProjectRelationRead => ({
  relation_id: `rel-${projectId}-${targetId}`,
  type,
  project_id: projectId,
  target_project_id: targetId,
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
});

/** The refusal the server answers a write it will not make with. */
const refusal = (message: string): ApiError =>
  new ApiError({
    status: 422,
    statusText: 'Unprocessable Entity',
    body: { error_code: 'INVALID_RELATION', message },
    url: '/api/workspaces/ws-1/projects/prj-1/relations',
    method: 'POST',
  });

/** One project's lane on the timeline. */
const lane = (projectId: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(
    `[data-timeline-project="${projectId}"]`
  );
  if (node === null) throw new Error(`no lane for ${projectId}`);
  return node;
};

/** The dot at one end of a project's bar that a link is dragged from. */
const handle = (projectId: string, side: 'start' | 'end'): HTMLElement => {
  const node = lane(projectId).querySelector<HTMLElement>(
    `[data-link-handle="${side}"]`
  );
  if (node === null) throw new Error(`no ${side} handle for ${projectId}`);
  return node;
};

/** The drawn dependency line from one project to another, if any. */
const line = (blockerId: string, blockedId: string): Element | null =>
  document.querySelector(`[data-dependency="${blockerId}:${blockedId}"]`);

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

const renderPage = (entry = '/w/mine/roadmap') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/roadmap" element={<Roadmap />} />
        <Route path="/w/:slug/projects/:id" element={<p>project page</p>} />
      </Routes>
    </MemoryRouter>
  );

describe('Roadmap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearToasts();
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listTeams.mockResolvedValue([engine, design]);
    listProjects.mockResolvedValue({
      projects: [launch, rebrand],
      next_cursor: null,
    });
  });

  it('draws a dated project as a bar over its dates', async () => {
    renderPage();

    expect(
      await screen.findByRole('slider', {
        name: 'Launch, 2026-09-20 to 2026-10-01',
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch' })).toHaveAttribute(
      'href',
      '/w/mine/projects/prj-1'
    );
  });

  it('lists an undated project without a bar', async () => {
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Rebrand' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: /^Rebrand/ })).toBeNull();
  });

  it('says so when there is nothing to plan', async () => {
    listProjects.mockResolvedValue({ projects: [], next_cursor: null });
    renderPage();

    expect(
      await screen.findByText(/No projects to plan yet/)
    ).toBeInTheDocument();
  });

  it('narrows to the team in the URL', async () => {
    renderPage('/w/mine/roadmap?team=DES');

    await waitFor(() => {
      expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-2' });
    });
  });

  it('moves a bar a day with the arrow keys', async () => {
    updateProject.mockImplementation((_id, patch) =>
      Promise.resolve({ ...launch, ...patch } as ProjectRead)
    );
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        start_date: '2026-09-21',
        target_date: '2026-10-02',
      });
    });
  });

  it('moves the end alone with shift', async () => {
    updateProject.mockImplementation((_id, patch) =>
      Promise.resolve({ ...launch, ...patch } as ProjectRead)
    );
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        start_date: '2026-09-20',
        target_date: '2026-10-02',
      });
    });
  });

  it('does not move a bar for a role that may not write', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    listTeams.mockResolvedValue(
      [
        { ...engine, role: 'member' },
        { ...design, role: 'member' },
      ].map(({ role: _role, ...rest }) => rest)
    );
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });

    expect(bar).toHaveAttribute('aria-readonly', 'true');
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('switches the zoom level', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    expect(screen.getByRole('radio', { name: 'Months' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('radio', { name: 'Weeks' }));
    expect(screen.getByRole('radio', { name: 'Weeks' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
  it('keeps one ungrouped list by default', async () => {
    renderPage();

    expect(
      await screen.findByRole('list', { name: 'Projects on the roadmap' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Engine' })).toBeNull();
  });

  it('groups lanes by team from the URL and folds a group', async () => {
    const user = userEvent.setup();
    listProjects.mockResolvedValue({
      projects: [launch, { ...rebrand, team_ids: ['team-2'] }],
      next_cursor: null,
    });
    renderPage('/w/mine/roadmap?group=team');

    const engineLanes = await screen.findByRole('list', { name: 'Engine' });
    expect(
      within(engineLanes).getByRole('link', { name: 'Launch' })
    ).toBeInTheDocument();
    const designLanes = screen.getByRole('list', { name: 'Design' });
    expect(
      within(designLanes).getByRole('link', { name: 'Rebrand' })
    ).toBeInTheDocument();

    const engineGroup = screen.getByRole('region', { name: 'Engine' });
    const toggle = within(engineGroup).getByRole('button', { name: /^Engine/ });
    await user.click(toggle);
    expect(screen.queryByRole('list', { name: 'Engine' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Launch' })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('groups lanes by status from the Display menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.selectOptions(screen.getByLabelText('Grouping'), 'status');

    expect(
      await screen.findByRole('list', { name: 'In progress' })
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Planned' })).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Projects on the roadmap' })
    ).toBeNull();
  });

  it('labels a bar with its progress', async () => {
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    expect(within(bar).getByText('50%')).toBeInTheDocument();
  });

  it('tints a bar with the project colour and shows its health', async () => {
    listProjects.mockResolvedValue({
      projects: [
        { ...launch, color: '#ef4444', icon: 'rocket', health: 'off_track' },
        rebrand,
      ],
      next_cursor: null,
    });
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    expect(bar).toHaveAttribute('data-color', '#ef4444');
    expect(bar.getAttribute('title')).toContain('Off track');
    expect(screen.getByRole('img', { name: 'Off track' })).toBeInTheDocument();
  });

  describe('dependency links', () => {
    beforeEach(() => {
      listProjects.mockResolvedValue({
        projects: [launch, ship],
        next_cursor: null,
      });
      createProjectRelation.mockReturnValue(new Promise(() => undefined));
    });

    it('makes the dragged-from project block the one dropped on', async () => {
      renderPage();
      await screen.findByRole('slider', { name: /^Ship/ });

      fireEvent.pointerDown(handle('prj-1', 'end'), { button: 0 });
      fireEvent.pointerEnter(lane('prj-3'));
      fireEvent.pointerUp(window);

      expect(line('prj-1', 'prj-3')).not.toBeNull();
      await waitFor(() => {
        expect(createProjectRelation).toHaveBeenCalledWith('prj-1', {
          type: 'blocks',
          target_project_id: 'prj-3',
        });
      });
    });

    it('makes the dragged-from project wait from its start dot', async () => {
      renderPage();
      await screen.findByRole('slider', { name: /^Ship/ });

      fireEvent.pointerDown(handle('prj-3', 'start'), { button: 0 });
      fireEvent.pointerEnter(lane('prj-1'));
      fireEvent.pointerUp(window);

      await waitFor(() => {
        expect(createProjectRelation).toHaveBeenCalledWith('prj-3', {
          type: 'blocked_by',
          target_project_id: 'prj-1',
        });
      });
    });

    it('makes no link when the drag is dropped on no project', async () => {
      renderPage();
      await screen.findByRole('slider', { name: /^Ship/ });

      fireEvent.pointerDown(handle('prj-1', 'end'), { button: 0 });
      fireEvent.pointerEnter(lane('prj-3'));
      fireEvent.pointerLeave(lane('prj-3'));
      fireEvent.pointerUp(window);

      expect(createProjectRelation).not.toHaveBeenCalled();
    });

    it('shows the server refusing a self link', async () => {
      createProjectRelation.mockRejectedValue(
        refusal('A project cannot block itself')
      );
      renderPage();
      const bar = await screen.findByRole('slider', { name: /^Launch/ });

      fireEvent.pointerDown(handle('prj-1', 'end'), { button: 0 });
      fireEvent.pointerEnter(bar);
      fireEvent.pointerUp(window);

      await waitFor(() => {
        expect(currentToasts().map((toast) => toast.message)).toEqual([
          'A project cannot block itself',
        ]);
      });
      expect(createProjectRelation).toHaveBeenCalledWith('prj-1', {
        type: 'blocks',
        target_project_id: 'prj-1',
      });
    });

    it('undoes a link the server refuses as a loop', async () => {
      createProjectRelation.mockRejectedValue(
        refusal('That dependency would make the projects wait on each other')
      );
      const user = userEvent.setup();
      renderPage();
      const bar = await screen.findByRole('slider', { name: /^Launch/ });

      fireEvent.keyDown(bar, { key: 'F10', shiftKey: true });
      await user.click(
        within(
          screen.getByRole('menu', { name: 'Dependencies of Launch' })
        ).getByRole('menuitem', { name: 'Blocks Ship' })
      );

      await waitFor(() => {
        expect(currentToasts().map((toast) => toast.message)).toEqual([
          'That dependency would make the projects wait on each other',
        ]);
      });
      expect(line('prj-1', 'prj-3')).toBeNull();
    });

    it('links from a focused bar with the keyboard', async () => {
      const user = userEvent.setup();
      renderPage();
      const bar = await screen.findByRole('slider', { name: /^Ship/ });

      fireEvent.keyDown(bar, { key: 'ContextMenu' });
      await user.click(
        screen.getByRole('menuitem', { name: 'Blocked by Launch' })
      );

      await waitFor(() => {
        expect(createProjectRelation).toHaveBeenCalledWith('prj-3', {
          type: 'blocked_by',
          target_project_id: 'prj-1',
        });
      });
      expect(line('prj-1', 'prj-3')).not.toBeNull();
    });

    it('offers no link menu to a role that may not write', async () => {
      useWorkspaceMock.mockReturnValue(resolved('guest'));
      listTeams.mockResolvedValue(
        [
          { ...engine, role: 'member' },
          { ...design, role: 'member' },
        ].map(({ role: _role, ...rest }) => rest)
      );
      renderPage();
      const bar = await screen.findByRole('slider', { name: /^Launch/ });

      fireEvent.keyDown(bar, { key: 'F10', shiftKey: true });

      expect(screen.queryByRole('menu')).toBeNull();
      expect(lane('prj-1').querySelector('[data-link-handle]')).toBeNull();
    });

    describe('with a dependency drawn', () => {
      beforeEach(() => {
        listProjects.mockResolvedValue({
          projects: [
            { ...launch, blocking_project_ids: ['prj-3'] },
            { ...ship, blocked_by_project_ids: ['prj-1'] },
          ],
          next_cursor: null,
        });
        listProjectRelations.mockResolvedValue([
          relation('blocks', 'prj-1', 'prj-3'),
        ]);
        deleteProjectRelation.mockReturnValue(new Promise(() => undefined));
      });

      it('lights a line on hover and removes it from its menu', async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByRole('slider', { name: /^Ship/ });
        const drawn = line('prj-1', 'prj-3');
        const hit = drawn?.querySelector('[data-dependency-hit]');
        if (drawn === null || hit === null || hit === undefined)
          throw new Error('no line drawn');

        fireEvent.pointerEnter(hit);
        expect(drawn).toHaveAttribute('data-active', 'true');
        fireEvent.click(hit);
        const menu = screen.getByRole('menu', { name: 'Launch blocks Ship' });
        await user.click(
          within(menu).getByRole('menuitem', { name: 'Remove dependency' })
        );

        await waitFor(() => {
          expect(deleteProjectRelation).toHaveBeenCalledWith(
            'prj-1',
            'rel-prj-1-prj-3'
          );
        });
        expect(line('prj-1', 'prj-3')).toBeNull();
      });

      it('removes a link from a focused bar with the keyboard', async () => {
        const user = userEvent.setup();
        renderPage();
        const bar = await screen.findByRole('slider', { name: /^Ship/ });

        fireEvent.keyDown(bar, { key: 'F10', shiftKey: true });
        expect(
          screen.queryByRole('menuitem', { name: 'Blocked by Launch' })
        ).toBeNull();
        listProjectRelations.mockResolvedValue([
          relation('blocked_by', 'prj-3', 'prj-1'),
        ]);
        await user.click(
          screen.getByRole('menuitem', { name: 'Remove: blocked by Launch' })
        );

        await waitFor(() => {
          expect(deleteProjectRelation).toHaveBeenCalledWith(
            'prj-3',
            'rel-prj-3-prj-1'
          );
        });
        expect(listProjectRelations).toHaveBeenCalledWith('prj-3');
      });
    });
  });

  it('marks each dated milestone with a diamond filled by its progress', async () => {
    listProjects.mockResolvedValue({
      projects: [
        {
          ...launch,
          milestone_markers: [
            {
              milestone_id: 'ms-1',
              name: 'Beta',
              target_date: '2026-09-25',
              completed: true,
              counts: {
                todo: 0,
                in_progress: 0,
                done: 2,
                cancelled: 0,
                total: 2,
              },
            },
            {
              milestone_id: 'ms-2',
              name: 'GA',
              target_date: '2026-09-30',
              completed: false,
              counts: {
                todo: 3,
                in_progress: 0,
                done: 1,
                cancelled: 0,
                total: 4,
              },
            },
          ],
        },
        rebrand,
      ],
      next_cursor: null,
    });
    renderPage();
    await screen.findByRole('slider', { name: /^Launch/ });

    const beta = screen.getByRole('link', {
      name: 'Beta, 100% of 2 issues complete',
    });
    expect(beta).toHaveAttribute(
      'title',
      'Beta, 100% of 2 issues complete · 2026-09-25'
    );
    expect(beta).toHaveAttribute('data-completed', 'true');
    expect(beta.querySelector('[data-milestone-glyph]')).toHaveAttribute(
      'data-milestone-glyph',
      'complete'
    );
    expect(beta).toHaveAttribute(
      'href',
      '/w/mine/projects/prj-1?tab=issues&f=milestone.is%3Ams-1'
    );
    const ga = screen.getByRole('link', {
      name: 'GA, 25% of 4 issues complete',
    });
    expect(ga).toHaveAttribute('data-completed', 'false');
    expect(ga.querySelector('[data-milestone-glyph]')).toHaveAttribute(
      'data-milestone-glyph',
      'partial'
    );
    expect(lane('prj-1').querySelectorAll('[data-milestone]')).toHaveLength(2);
    expect(lane('prj-2').querySelectorAll('[data-milestone]')).toHaveLength(0);
  });
});
