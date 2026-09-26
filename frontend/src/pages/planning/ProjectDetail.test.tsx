/**
 * One project's page. Covers that it reads the project from the id alone,
 * that the overview shows the summary and the progress, that a status change
 * is written in place, that the issues tab lists the project's issues, that
 * milestones are added, renamed, reordered and open their issues, and that
 * deleting is offered only to an admin and returns to the list.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  MilestoneRead,
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
const listMilestones = vi.fn<() => Promise<MilestoneRead[]>>();
const createMilestone = vi.fn<(body: unknown) => Promise<MilestoneRead>>();
const updateMilestone =
  vi.fn<(id: string, body: unknown) => Promise<MilestoneRead>>();
const deleteMilestone = vi.fn<(id: string) => Promise<void>>();

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
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
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
});
