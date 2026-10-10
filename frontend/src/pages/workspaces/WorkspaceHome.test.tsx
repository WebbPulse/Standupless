/**
 * The workspace home: the setup steps for a workspace with no team, the
 * ask-an-admin note for someone who may not create one, the focus groups and
 * the summary line drawn from the one home read, the side sections, keyboard
 * movement across sections, and a warm return that draws without a skeleton.
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
  CycleRead,
  HomeRead,
  IssueRead,
  MemberRead,
  ProjectRead,
  TeamRead,
} from '../../types/Api';
import WorkspaceHome from './WorkspaceHome';
import { clearHomeCache } from './home/homeCache';

const getHome = vi.fn<() => Promise<HomeRead>>();
const useTeamsMock = vi.fn<() => UseTeamsResult>();
const openCreateTeam = vi.fn<() => void>();
const canCreateTeam = vi.fn<() => boolean>();
const membersMock = vi.fn<() => MemberRead[]>();

vi.mock('../../api/home', () => ({
  getHome: () => getHome(),
  browserTimezone: () => 'UTC',
}));

vi.mock('../../api/integrations', () => ({
  readInstallation: () => Promise.resolve({ status: 'not_installed' }),
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

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => membersMock(),
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
const issue: IssueRead = {
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

/** An overdue issue assigned to the caller. */
const late: IssueRead = {
  ...issue,
  id: 'iss-2',
  key: 'ENG-3',
  number: 3,
  title: 'Renew the signing certificate',
  due_date: '2026-09-01',
};

/** An issue that shipped this week. */
const shipped: IssueRead = {
  ...issue,
  id: 'iss-3',
  key: 'ENG-9',
  number: 9,
  title: 'Cache the issue search',
};

const counts = { todo: 2, in_progress: 1, done: 1, cancelled: 0, total: 4 };

/** The cycle the caller's team is running now. */
const cycle: CycleRead = {
  cycle_id: 'cyc-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  name: 'Cycle 12',
  number: 12,
  start_date: '2026-09-20',
  end_date: '2026-10-04',
  goal: null,
  cancelled: false,
  status: 'active',
  counts,
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** A project in flight whose update is overdue. */
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
  icon: null,
  color: null,
  health: 'at_risk',
  priority: 'none',
  member_ids: [],
  counts,
  update_due_state: 'overdue',
  next_update_due_at: '2026-09-30T00:00:00Z',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** A home with something in every section. */
const fullHome = (): HomeRead => ({
  generated_at: '2026-10-09T12:00:00Z',
  today: '2026-10-09',
  team_ids: ['team-1'],
  focus: {
    open_count: 2,
    truncated: false,
    attention_count: 1,
    in_progress_count: 1,
    up_next_count: 0,
    attention: [{ issue: late, reasons: ['overdue'] }],
    in_progress: [issue],
    up_next: [],
  },
  cycles: [cycle],
  projects: [launch],
  projects_total: 1,
  shipped: {
    since: '2026-10-02T12:00:00Z',
    count: 3,
    mine: 1,
    items: [
      {
        issue: shipped,
        completed_at: '2026-10-08T12:00:00Z',
        completed_by: 'user-1',
      },
    ],
  },
  pulse: [
    {
      project_id: 'prj-1',
      project_name: 'Public launch',
      update: {
        update_id: 'upd-1',
        workspace_id: 'ws-1',
        project_id: 'prj-1',
        body: 'Slipping a week on the billing page',
        health: 'at_risk',
        author_id: 'user-1',
        created_at: '2026-10-08T12:00:00Z',
        updated_at: '2026-10-08T12:00:00Z',
        edited_at: null,
        can_edit: false,
      },
    },
  ],
  inbox: { unread_count: 4, items: [] },
});

/** A home with nothing in it. */
const quietHome = (): HomeRead => ({
  ...fullHome(),
  focus: {
    open_count: 0,
    truncated: false,
    attention_count: 0,
    in_progress_count: 0,
    up_next_count: 0,
    attention: [],
    in_progress: [],
    up_next: [],
  },
  cycles: [],
  projects: [],
  projects_total: 0,
  shipped: { since: '2026-10-02T12:00:00Z', count: 0, mine: 0, items: [] },
  pulse: [],
  inbox: { unread_count: 0, items: [] },
});

/** One workspace member. */
const member = (id: string): MemberRead => ({
  user_id: id,
  email: `${id}@example.com`,
  display_name: id === 'user-1' ? 'Maya Chen' : 'Sam Ortiz',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
});

/** A settled team list holding `teams`. */
const teamsResult = (teams: TeamRead[]): UseTeamsResult => ({
  data: teams,
  isLoading: false,
  error: null,
  refetch: () => Promise.resolve(),
  workspaceId: 'ws-1',
});

/** Mounts the page under its workspace route, with a stand in issue page. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/acme']}>
      <Routes>
        <Route path="/w/:slug" element={<WorkspaceHome />} />
        <Route path="/w/:slug/issues/:key" element={<p>Issue page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  clearHomeCache();
  getHome.mockReset();
  openCreateTeam.mockReset();
  canCreateTeam.mockReturnValue(true);
  useTeamsMock.mockReturnValue(teamsResult([team]));
  membersMock.mockReturnValue([member('user-1'), member('user-2')]);
  getHome.mockResolvedValue(fullHome());
});

describe('WorkspaceHome', () => {
  it('walks a new workspace through its setup steps', async () => {
    useTeamsMock.mockReturnValue(teamsResult([]));
    membersMock.mockReturnValue([member('user-1')]);
    const user = userEvent.setup();
    renderPage();

    const steps = screen.getByRole('region', {
      name: 'Set up your workspace',
    });
    expect(within(steps).getByText('Invite your people')).toBeVisible();
    expect(
      within(steps).getByRole('link', { name: 'Invite people' })
    ).toHaveAttribute('href', '/w/acme/settings');
    expect(
      await within(steps).findByRole('link', { name: 'Connect GitHub' })
    ).toHaveAttribute('href', '/w/acme/settings');

    await user.click(
      within(steps).getByRole('button', { name: /Create a team/ })
    );
    expect(openCreateTeam).toHaveBeenCalled();
    expect(getHome).not.toHaveBeenCalled();
  });

  it('tells someone with no team who may not create one to ask an admin', () => {
    useTeamsMock.mockReturnValue(teamsResult([]));
    canCreateTeam.mockReturnValue(false);
    renderPage();

    expect(screen.getByText(/Ask a workspace admin/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Create a team/ })
    ).not.toBeInTheDocument();
  });

  it('groups the caller focus and sums up the day', async () => {
    renderPage();

    const focus = await screen.findByRole('list', { name: 'Your open issues' });
    expect(within(focus).getByText('Overdue')).toBeVisible();
    expect(within(focus).getByText('In progress')).toBeVisible();
    const titles = within(focus)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(titles.join(' ')).toMatch(/Renew the signing certificate.*Rate/);

    expect(screen.getByText('1 need attention')).toBeVisible();
    expect(screen.getByText('3 issues shipped this week')).toBeVisible();
    expect(screen.getByRole('link', { name: '4 unread' })).toHaveAttribute(
      'href',
      '/w/acme/inbox'
    );
  });

  it('shows shipped work, cycles, projects with the stale flag, and updates', async () => {
    renderPage();

    const shippedList = await screen.findByRole('list', {
      name: 'Shipped this week',
    });
    expect(
      within(shippedList).getByText('Cache the issue search')
    ).toBeVisible();

    const planning = screen.getByRole('complementary', { name: 'Planning' });
    expect(
      within(planning).getByRole('link', { name: 'Cycle 12' })
    ).toHaveAttribute('href', '/w/acme/team/ENG/cycles/cyc-1');
    const projects = within(planning).getByRole('list', {
      name: 'Projects in flight',
    });
    expect(within(projects).getByText('Public launch')).toBeVisible();
    expect(within(projects).getByText('Update overdue')).toBeVisible();
    expect(
      within(planning).getByText('Slipping a week on the billing page')
    ).toBeVisible();
    expect(within(planning).getByText(/Maya Chen/)).toBeVisible();
  });

  it('says so when every section is empty', async () => {
    getHome.mockResolvedValue(quietHome());
    renderPage();

    expect(
      await screen.findByText(/Nothing open is assigned to you/)
    ).toBeInTheDocument();
    expect(
      screen.getByText('None of your teams has a cycle running.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('No projects are planned or in progress.')
    ).toBeInTheDocument();
    expect(screen.getByText('You are all caught up.')).toBeInTheDocument();
  });

  it('offers the setup steps beside the home while GitHub is not connected', async () => {
    renderPage();

    const steps = await screen.findByRole('region', {
      name: 'Set up your workspace',
    });
    expect(within(steps).getByText('2 of 3')).toBeVisible();
    expect(
      within(steps).queryByRole('link', { name: 'Invite people' })
    ).not.toBeInTheDocument();
  });

  it('opens the highlighted row on Enter after moving with j', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('list', { name: 'Your open issues' });

    await user.keyboard('j');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Issue page')).toBeVisible();
  });

  it('draws the last read at once on a return visit', async () => {
    const first = renderPage();
    await screen.findByRole('list', { name: 'Your open issues' });
    first.unmount();

    getHome.mockReturnValue(new Promise(() => undefined));
    renderPage();

    expect(
      screen.getByRole('list', { name: 'Your open issues' })
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Loading your home')
    ).not.toBeInTheDocument();
  });
});
