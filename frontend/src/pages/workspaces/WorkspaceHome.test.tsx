/**
 * The workspace home overview: the first team call to action for someone who
 * may create one and the ask-an-admin note for someone who may not, the open
 * issues assigned to the caller and their empty state, and the active cycles
 * and projects in the side column.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type { UseTeamsResult } from '../../hooks/useTeams';
import type {
  IssueListRead,
  IssueRead,
  ProjectRead,
  RoadmapEntryRead,
  RoadmapListRead,
  TeamRead,
} from '../../types/Api';
import WorkspaceHome from './WorkspaceHome';

const listIssues =
  vi.fn<(query: Record<string, unknown>) => Promise<IssueListRead>>();
const listRoadmap = vi.fn<() => Promise<RoadmapListRead>>();
const useTeamsMock = vi.fn<() => UseTeamsResult>();
const openCreateTeam = vi.fn<() => void>();
const canCreateTeam = vi.fn<() => boolean>();
const projectsMock = vi.fn<() => ProjectRead[]>();

vi.mock('../../api/issues', () => ({
  ME: 'me',
  listIssues: (_workspaceId: string, query: Record<string, unknown>) =>
    listIssues(query),
}));

vi.mock('../../api/planning', () => ({
  listRoadmap: () => listRoadmap(),
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

vi.mock('../../hooks/useAuth', () => ({
  useAuth: (): AuthContextType => ({
    isAuthenticated: true,
    isLoading: false,
    isBusy: false,
    user: {
      id: 'user-1',
      email: 'maya@example.com',
      display_name: 'Maya Chen',
      email_verified: true,
    },
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: (): WorkspaceContextType => ({
    workspace: {
      id: 'ws-1',
      name: 'Acme',
      slug: 'acme',
      plan: 'free',
      created_at: '2026-09-17T00:00:00Z',
      role: 'owner',
    },
    isLoading: false,
    notFound: false,
    error: null,
    refresh: () => Promise.resolve(),
  }),
}));

vi.mock('../../hooks/useTeams', () => ({
  useTeams: () => useTeamsMock(),
}));

vi.mock('../../hooks/useCreateTeam', () => ({
  useCreateTeam: () => ({ open: openCreateTeam, canCreate: canCreateTeam() }),
}));

vi.mock('../../hooks/useCreateIssue', () => ({
  useCreateIssue: () => ({ open: vi.fn(), canCreate: true }),
}));

vi.mock('../../hooks/useIssueContext', () => ({
  useIssueContext: () => ({
    context: { statuses: [], labels: [], people: [], projects: [], cycles: [] },
    forTeam: () => ({
      statuses: [],
      labels: [],
      people: [],
      projects: [],
      cycles: [],
    }),
    isLoading: false,
    createLabel: () => Promise.resolve(null),
  }),
}));

vi.mock('../../hooks/useWorkspaceProjects', () => ({
  useWorkspaceProjects: () => ({
    projects: projectsMock(),
    error: null,
    isLoading: false,
    queryKey: ['projects'],
  }),
}));

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({
    title,
    actions,
    children,
  }: {
    title?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

/** The one team the caller belongs to. */
const team: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engineering',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
  is_member: true,
};

/** An open issue assigned to the caller. */
const assigned: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-7',
  number: 7,
  title: 'Rate limit the search endpoint',
  body: null,
  status_id: 'st-1',
  priority: 'high',
  assignee_id: 'user-1',
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** An issue someone else changed recently. */
const recent: IssueRead = {
  ...assigned,
  id: 'iss-2',
  key: 'ENG-8',
  number: 8,
  title: 'Flaky checkout test',
  assignee_id: null,
};

/** The cycle the caller's team is running now. */
const cycle: RoadmapEntryRead = {
  kind: 'cycle',
  id: 'cyc-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  name: 'Cycle 12',
  start_date: '2026-09-20',
  target_date: '2026-10-04',
  status: 'active',
  counts: { todo: 2, in_progress: 1, done: 1, cancelled: 0, total: 4 },
};

/** A project in flight. */
const launch: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: '2026-09-20',
  name: 'Public launch',
  description: null,
  target_date: '2026-10-01',
  status: 'in_progress',
  counts: { todo: 1, in_progress: 1, done: 2, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** A settled team list holding `teams`. */
const teamsResult = (teams: TeamRead[]): UseTeamsResult => ({
  data: teams,
  isLoading: false,
  error: null,
  refetch: () => Promise.resolve(),
  workspaceId: 'ws-1',
});

/** Mounts the page under its workspace route. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/acme']}>
      <Routes>
        <Route path="/w/:slug" element={<WorkspaceHome />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listIssues.mockReset();
  listRoadmap.mockReset();
  openCreateTeam.mockReset();
  canCreateTeam.mockReturnValue(true);
  useTeamsMock.mockReturnValue(teamsResult([team]));
  projectsMock.mockReturnValue([]);
  listIssues.mockImplementation((query) =>
    Promise.resolve({
      issues: query['assignee_id'] === 'me' ? [assigned] : [assigned, recent],
      next_cursor: null,
    })
  );
  listRoadmap.mockResolvedValue({ entries: [], next_cursor: null });
});

describe('WorkspaceHome', () => {
  it('offers to create the first team to someone who may', async () => {
    useTeamsMock.mockReturnValue(teamsResult([]));
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Create a team/ }));

    expect(openCreateTeam).toHaveBeenCalled();
    expect(listIssues).not.toHaveBeenCalled();
  });

  it('tells a guest with no team to ask an admin', () => {
    useTeamsMock.mockReturnValue(teamsResult([]));
    canCreateTeam.mockReturnValue(false);
    renderPage();

    expect(screen.getByText(/Ask a workspace admin/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Create a team/ })
    ).not.toBeInTheDocument();
  });

  it('leads with the open issues assigned to the caller', async () => {
    renderPage();

    expect(screen.getByText('Welcome back, Maya')).toBeInTheDocument();
    const mine = await screen.findByRole('list', {
      name: 'Issues assigned to you',
    });
    expect(
      within(mine).getByText('Rate limit the search endpoint')
    ).toBeVisible();
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee_id: 'me',
        status_category_not: ['completed', 'cancelled'],
      })
    );

    const moved = await screen.findByRole('list', {
      name: 'Recently updated issues',
    });
    expect(within(moved).getByText('Flaky checkout test')).toBeVisible();
    expect(
      within(moved).queryByText('Rate limit the search endpoint')
    ).not.toBeInTheDocument();
  });

  it('says so when nothing open is assigned', async () => {
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
    renderPage();

    expect(
      await screen.findByText(/Nothing open is assigned to you/)
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Issues your teams change will show up here.')
    ).toBeInTheDocument();
  });

  it('shows the active cycles and projects in flight', async () => {
    listRoadmap.mockResolvedValue({ entries: [cycle], next_cursor: null });
    projectsMock.mockReturnValue([launch]);
    renderPage();

    const planning = screen.getByRole('complementary', { name: 'Planning' });
    expect(await within(planning).findByText('Cycle 12')).toBeVisible();
    expect(
      within(planning).getByRole('link', { name: /Cycle 12/ })
    ).toHaveAttribute('href', '/w/acme/team/ENG/cycles/cyc-1');
    expect(within(planning).getByText('Public launch')).toBeVisible();
  });

  it('says so when no cycle or project is running', async () => {
    renderPage();

    expect(
      await screen.findByText('None of your teams has a cycle running.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('No projects are planned or in progress.')
    ).toBeInTheDocument();
  });
});
