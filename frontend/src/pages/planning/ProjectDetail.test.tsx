/**
 * One project's page. Covers that it reads the project from the id alone,
 * that the overview shows the summary and the progress, that a status,
 * health, priority, member, icon and colour change is written in place, that the issues tab lists the project's issues, that
 * milestones are added, renamed, reordered and open their issues, and that
 * deleting is offered only to an admin and returns to the list. The updates
 * tab opens from `?tab=updates`, lists updates under their anchors, posts,
 * edits and deletes them, and a quiet live project nudges for one.
 */

import type { Editor } from '@tiptap/core';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  MilestoneRead,
  ProjectRead,
  ProjectUpdateListRead,
  ProjectUpdateRead,
  TeamMemberRead,
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
const listMilestones = vi.fn<() => Promise<MilestoneRead[]>>();
const createMilestone = vi.fn<(body: unknown) => Promise<MilestoneRead>>();
const updateMilestone =
  vi.fn<(id: string, body: unknown) => Promise<MilestoneRead>>();
const deleteMilestone = vi.fn<(id: string) => Promise<void>>();
const listProjectUpdates =
  vi.fn<(query: unknown) => Promise<ProjectUpdateListRead>>();
const createProjectUpdate =
  vi.fn<(body: unknown) => Promise<ProjectUpdateRead>>();
const updateProjectUpdate =
  vi.fn<(id: string, body: unknown) => Promise<ProjectUpdateRead>>();
const deleteProjectUpdate = vi.fn<(id: string) => Promise<void>>();
const listTeamMembers = vi.fn<() => Promise<TeamMemberRead[]>>();

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
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
  listMilestones: () => listMilestones(),
  createMilestone: (_w: string, _p: string, body: unknown) =>
    createMilestone(body),
  updateMilestone: (_w: string, _p: string, id: string, body: unknown) =>
    updateMilestone(id, body),
  deleteMilestone: (_w: string, _p: string, id: string) => deleteMilestone(id),
  listProjectUpdates: (_w: string, _p: string, query: unknown) =>
    listProjectUpdates(query),
  createProjectUpdate: (_w: string, _p: string, body: unknown) =>
    createProjectUpdate(body),
  updateProjectUpdate: (_w: string, _p: string, id: string, body: unknown) =>
    updateProjectUpdate(id, body),
  deleteProjectUpdate: (_w: string, _p: string, id: string) =>
    deleteProjectUpdate(id),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => listTeamMembers(),
}));

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listIssues: (_w: string, query: unknown) => listIssues(query),
    appendIssues: (held: unknown) => held,
  };
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

/** Builds a milestone of the project. */
const milestone = (
  id: string,
  name: string,
  sortOrder: string
): MilestoneRead => ({
  milestone_id: id,
  workspace_id: 'ws-1',
  project_id: 'prj-1',
  name,
  description: null,
  target_date: null,
  sort_order: sortOrder,
  counts: { todo: 1, in_progress: 0, done: 1, cancelled: 0, total: 2 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
});

/** Builds an update of the project. */
const projectUpdate = (
  id: string,
  body: string,
  overrides: Partial<ProjectUpdateRead> = {}
): ProjectUpdateRead => ({
  update_id: id,
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  body,
  health: 'on_track',
  author_id: 'user-1',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
  edited_at: null,
  can_edit: true,
  ...overrides,
});

/** The person who writes the updates. */
const ada: TeamMemberRead = {
  user_id: 'user-1',
  email: 'ada@example.com',
  display_name: 'Ada Lovelace',
  role: 'admin',
  added_at: '2026-09-17T00:00:00Z',
};

/** The update composer's surface once the lazy editor has arrived. */
const findComposer = async (): Promise<HTMLElement> =>
  screen.findByRole(
    'textbox',
    { name: 'Write a project update' },
    { timeout: 10_000 }
  );

/** Types into a rich editor surface through its Tiptap instance. */
const typeInto = (surface: HTMLElement, text: string): void => {
  act(() => {
    (surface as HTMLElement & { editor: Editor }).editor.commands.setContent(
      text
    );
  });
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
    listMilestones.mockResolvedValue([]);
    listProjectUpdates.mockResolvedValue({ updates: [], next_cursor: null });
    listTeamMembers.mockResolvedValue([ada]);
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

  it('puts the properties in a chip row under the name', async () => {
    renderPage();

    const row = await screen.findByRole('group', { name: 'Properties' });
    expect(
      within(row).getByRole('button', { name: /^Status: / })
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: /^Lead: / })
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: /^Start date: / })
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: /^Target date: / })
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Health: No updates' })
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: /^Priority: / })
    ).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Members: Members' })
    ).toBeInTheDocument();
  });

  it('writes a health change in place', async () => {
    const user = userEvent.setup();
    updateProject.mockResolvedValue({ ...launch, health: 'at_risk' });
    renderPage();

    const row = await screen.findByRole('group', { name: 'Properties' });
    await user.click(
      within(row).getByRole('button', { name: 'Health: No updates' })
    );
    await user.click(await screen.findByRole('option', { name: /At risk/ }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ health: 'at_risk' });
    });
  });

  it('writes a priority change in place', async () => {
    const user = userEvent.setup();
    updateProject.mockResolvedValue({ ...launch, priority: 'high' });
    renderPage();

    const row = await screen.findByRole('group', { name: 'Properties' });
    await user.click(within(row).getByRole('button', { name: /^Priority: / }));
    await user.click(await screen.findByRole('option', { name: /High/ }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ priority: 'high' });
    });
  });

  it('picks an icon and a colour from the project mark', async () => {
    const user = userEvent.setup();
    updateProject.mockImplementation((body) =>
      Promise.resolve({ ...launch, ...(body as Partial<ProjectRead>) })
    );
    renderPage();

    await screen.findByText('Getting it out');
    await user.click(screen.getByRole('button', { name: 'Icon and colour' }));
    await user.click(await screen.findByRole('radio', { name: 'Icon rocket' }));

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ icon: 'rocket' });
    });
    await user.click(
      await screen.findByRole('radio', { name: 'Colour #ef4444' })
    );

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ color: '#ef4444' });
    });
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

  it('shows each milestone with its progress', async () => {
    listMilestones.mockResolvedValue([
      milestone('ms-2', 'Beta', 'X'),
      milestone('ms-1', 'Alpha', 'V'),
    ]);
    renderPage();

    const list = await screen.findByRole('list', { name: 'Milestones' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(within(list).getAllByText('50% of 2')).toHaveLength(2);
  });

  it('adds a milestone typed into the list', async () => {
    const user = userEvent.setup();
    createMilestone.mockResolvedValue(milestone('ms-1', 'Alpha', 'V'));
    renderPage();

    await screen.findByText('Getting it out');
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));
    await user.type(
      screen.getByRole('textbox', { name: 'New milestone name' }),
      'Alpha{Enter}'
    );

    await waitFor(() => {
      expect(createMilestone).toHaveBeenCalledWith({ name: 'Alpha' });
    });
  });

  it('moves a milestone up between its neighbours', async () => {
    const user = userEvent.setup();
    listMilestones.mockResolvedValue([
      milestone('ms-1', 'Alpha', 'V'),
      milestone('ms-2', 'Beta', 'X'),
    ]);
    updateMilestone.mockResolvedValue(milestone('ms-2', 'Beta', 'U'));
    renderPage();

    await screen.findByRole('list', { name: 'Milestones' });
    await user.click(screen.getByRole('button', { name: 'Beta actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));

    await waitFor(() => {
      expect(updateMilestone).toHaveBeenCalledWith('ms-2', {
        sort_order: expect.any(String) as string,
      });
    });
    const call = updateMilestone.mock.calls[0];
    const key = (call?.[1] as { sort_order: string }).sort_order;
    expect(key < 'V').toBe(true);
  });

  it('opens the issues of one milestone', async () => {
    const user = userEvent.setup();
    listMilestones.mockResolvedValue([milestone('ms-1', 'Alpha', 'V')]);
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /^Alpha issues/ })
    );

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({
          project_id: 'prj-1',
          project_milestone_id: ['ms-1'],
        })
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

  it('opens the updates tab from the address and lists each update', async () => {
    listProjectUpdates.mockResolvedValue({
      updates: [
        projectUpdate('upd-2', 'Slipping a week', {
          health: 'at_risk',
          edited_at: '2026-09-25T01:00:00Z',
          can_edit: false,
        }),
        projectUpdate('upd-1', 'Kicked off'),
      ],
      next_cursor: 'next',
    });
    const { container } = renderPage('/w/mine/projects/prj-1?tab=updates');

    expect(await screen.findByText('Slipping a week')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const newest = container.querySelector('#update-upd-2');
    expect(newest).not.toBeNull();
    expect(within(newest as HTMLElement).getByText('At risk')).toBeVisible();
    expect(within(newest as HTMLElement).getByText('(edited)')).toBeVisible();
    await waitFor(() => {
      expect(
        within(newest as HTMLElement).getByText('Ada Lovelace')
      ).toBeVisible();
    });
    expect(container.querySelector('#update-upd-1')).not.toBeNull();
    expect(listProjectUpdates).toHaveBeenCalledWith({ limit: 20 });
    expect(screen.getByRole('button', { name: 'Load more' })).toBeVisible();
  });

  it('posts an update with the health it calls', async () => {
    const user = userEvent.setup();
    createProjectUpdate.mockResolvedValue(projectUpdate('upd-3', 'Beta out'));
    renderPage('/w/mine/projects/prj-1?tab=updates');

    await user.click(
      await screen.findByRole('button', { name: /Write a project update/ })
    );
    const surface = await findComposer();
    typeInto(surface, 'Beta out');
    await user.click(screen.getByRole('radio', { name: /At risk/ }));
    await user.click(screen.getByRole('button', { name: /^Post update/ }));

    await waitFor(() => {
      expect(createProjectUpdate).toHaveBeenCalledWith({
        body: 'Beta out',
        health: 'at_risk',
      });
    });
    await waitFor(() => {
      expect(getProject.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('edits and deletes an update the reader may change', async () => {
    const user = userEvent.setup();
    listProjectUpdates.mockResolvedValue({
      updates: [projectUpdate('upd-1', 'Kicked off')],
      next_cursor: null,
    });
    updateProjectUpdate.mockResolvedValue(
      projectUpdate('upd-1', 'Kicked off', { health: 'off_track' })
    );
    deleteProjectUpdate.mockResolvedValue(undefined);
    renderPage('/w/mine/projects/prj-1?tab=updates');

    await screen.findByText('Kicked off');
    await user.click(screen.getByRole('button', { name: 'Update actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Edit/ }));
    await screen.findByRole(
      'textbox',
      { name: 'Edit update' },
      { timeout: 10_000 }
    );
    await user.click(screen.getByRole('radio', { name: /Off track/ }));
    await user.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(() => {
      expect(updateProjectUpdate).toHaveBeenCalledWith('upd-1', {
        body: 'Kicked off',
        health: 'off_track',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Update actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    await user.click(
      await screen.findByRole('button', { name: 'Delete update' })
    );
    await waitFor(() => {
      expect(deleteProjectUpdate).toHaveBeenCalledWith('upd-1');
    });
  });

  it('offers only a link on an update the reader may not change', async () => {
    const user = userEvent.setup();
    listProjectUpdates.mockResolvedValue({
      updates: [projectUpdate('upd-1', 'Kicked off', { can_edit: false })],
      next_cursor: null,
    });
    renderPage('/w/mine/projects/prj-1?tab=updates');

    await screen.findByText('Kicked off');
    await user.click(screen.getByRole('button', { name: 'Update actions' }));
    expect(
      await screen.findByRole('menuitem', { name: /Copy link/ })
    ).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull();
  });

  it('nudges a live project with no updates toward the composer', async () => {
    const user = userEvent.setup();
    renderPage();

    const nudge = await screen.findByText('No updates yet');
    await user.click(
      within(nudge.closest('[role="status"]') as HTMLElement).getByRole(
        'button',
        { name: 'Write update' }
      )
    );

    expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await findComposer()).toBeInTheDocument();
  });

  it('does not nudge a project with a recent update', async () => {
    getProject.mockResolvedValue({
      ...launch,
      last_update_at: new Date().toISOString(),
    });
    renderPage();

    await screen.findByText('Getting it out');
    expect(screen.queryByText('No updates yet')).toBeNull();
    expect(screen.queryByText('No update in 2 weeks')).toBeNull();
  });

  it('shows the latest update in the progress panel', async () => {
    const user = userEvent.setup();
    listProjectUpdates.mockResolvedValue({
      updates: [projectUpdate('upd-1', 'Kicked off')],
      next_cursor: null,
    });
    renderPage();

    const panel = await screen.findByRole('complementary', {
      name: 'Project progress',
    });
    expect(await within(panel).findByText('Kicked off')).toBeVisible();
    await user.click(
      within(panel).getByRole('button', { name: 'See all updates' })
    );
    expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });
});
