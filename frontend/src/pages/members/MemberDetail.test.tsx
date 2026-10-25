/**
 * The member page. Covers that the issue tabs read the member's assigned,
 * created and subscribed issues through the shared list, that the header
 * names the member and their teams without an email, that the Activity tab
 * draws the rows the server returned, which are already limited to issues
 * the viewer can read, and that someone outside the workspace reads as not
 * found.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../api/issues';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import { PeekProvider } from '../../components/workspace/PeekPane';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import type {
  IssueListRead,
  MemberActivityListRead,
  MemberProfileRead,
  StatusRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import MemberDetail from './MemberDetail';

const getMemberProfile =
  vi.fn<(userId: string) => Promise<MemberProfileRead>>();
const listMemberActivity =
  vi.fn<(userId: string) => Promise<MemberActivityListRead>>();

vi.mock('../../api/members', () => ({
  getMemberProfile: (_w: string, userId: string) => getMemberProfile(userId),
  listMemberActivity: (_w: string, userId: string) =>
    listMemberActivity(userId),
}));

const listIssues =
  vi.fn<(query: Record<string, unknown>) => Promise<IssueListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<(teamId: string) => Promise<StatusRead[]>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: 'user-1', email: 'me@example.com' },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listIssues: (_w: string, query: Record<string, unknown>) =>
      listIssues(query),
  };
});

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: (_w: string, teamId: string) => listStatuses(teamId),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
}));

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return { ...actual, listViews: () => Promise.resolve([]) };
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

/** A team with the given name and prefix. */
const teamOf = (id: string, name: string, prefix: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: prefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
});

const teams = [
  teamOf('team-1', 'Engine', 'ENG'),
  teamOf('team-2', 'Web', 'WEB'),
];

/** The same statuses in each team, told apart by id. */
const statusesFor = (teamId: string): StatusRead[] => [
  { id: `${teamId}-todo`, name: 'Todo', category: 'unstarted', position: 0 },
  { id: `${teamId}-done`, name: 'Done', category: 'completed', position: 1 },
];

/** An issue assigned to the caller with the given fields. */
const issue = (fields: Partial<OrderedIssueRead>): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'team-1-todo',
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
  ...fields,
});

const issues = [
  issue({}),
  issue({
    id: 'iss-2',
    team_id: 'team-2',
    key: 'WEB-4',
    number: 4,
    title: 'Ship the pricing page',
    status_id: 'team-2-todo',
  }),
  issue({
    id: 'iss-3',
    key: 'ENG-3',
    number: 3,
    title: 'Retire the old cache',
    status_id: 'team-1-done',
  }),
  issue({
    id: 'iss-4',
    key: 'ENG-5',
    number: 5,
    title: 'Measure hit rate',
    parent_id: 'iss-1',
  }),
];

/** A resolved workspace context, since the shell renders only once it is. */
const resolved = (): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

const creator: CreateIssueState = {
  open: vi.fn(),
  close: vi.fn(),
  isOpen: false,
  canCreate: true,
  request: null,
};

const riley: MemberProfileRead = {
  user_id: 'user-7',
  display_name: 'riley',
  full_name: 'Riley Chen',
  avatar_url: null,
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
  team_ids: ['team-2'],
};

const activity: MemberActivityListRead = {
  activity: [
    {
      type: 'comment',
      id: 'c-1',
      created_at: '2026-10-20T10:00:00Z',
      issue_id: 'iss-2',
      issue_key: 'WEB-4',
      issue_title: 'Ship the pricing page',
      team_id: 'team-2',
      activity: null,
      comment: {
        comment_id: 'c-1',
        body: 'Pricing copy is ready',
        parent_comment_id: null,
      },
    },
    {
      type: 'issue_change',
      id: 'a-1',
      created_at: '2026-10-19T10:00:00Z',
      issue_id: 'iss-1',
      issue_key: 'ENG-1',
      issue_title: 'Cache the token',
      team_id: 'team-1',
      activity: {
        activity_id: 'a-1',
        issue_id: 'iss-1',
        actor_id: 'user-7',
        actor_kind: 'user',
        kind: 'created',
        field: null,
        from: null,
        to: null,
        created_at: '2026-10-19T10:00:00Z',
      },
      comment: null,
    },
  ],
  next_cursor: null,
};

/** Mounts the page at its route inside the shell's providers. */
const renderPage = (path = '/w/mine/members/user-7') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <PeekProvider>
          <CreateIssueContext.Provider value={creator}>
            <Routes>
              <Route
                path="/w/:slug/members/:userId"
                element={<MemberDetail />}
              />
            </Routes>
          </CreateIssueContext.Provider>
        </PeekProvider>
      </ShortcutProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  listIssues.mockReset();
  listTeams.mockReset();
  listStatuses.mockReset();
  getMemberProfile.mockReset();
  listMemberActivity.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listTeams.mockResolvedValue(teams);
  listStatuses.mockImplementation((teamId) =>
    Promise.resolve(statusesFor(teamId))
  );
  listIssues.mockResolvedValue({ issues, next_cursor: null });
  getMemberProfile.mockResolvedValue(riley);
  listMemberActivity.mockResolvedValue(activity);
});

describe('the member page', () => {
  it('heads with the member and the teams the viewer can see', async () => {
    renderPage();

    expect(
      await screen.findByRole('heading', { name: /riley/ })
    ).toBeInTheDocument();
    const teamList = screen.getByRole('list', { name: 'Teams' });
    expect(within(teamList).getByRole('link', { name: 'Web' })).toHaveAttribute(
      'href',
      '/w/mine/team/WEB'
    );
    expect(within(teamList).queryByText('Engine')).not.toBeInTheDocument();
  });

  it('reads the issues assigned to the member on the default tab', async () => {
    renderPage();

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ assignee_id: 'user-7' })
      );
    });
    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assigned' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('reads what the member created and subscribed to on those tabs', async () => {
    renderPage('/w/mine/members/user-7?tab=created');
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ creator_id: 'user-7' })
      );
    });
  });

  it('reads subscriptions on the Subscribed tab', async () => {
    renderPage('/w/mine/members/user-7?tab=subscribed');
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ subscriber_id: 'user-7' })
      );
    });
  });

  it('lists the activity rows the server returned, newest first', async () => {
    renderPage('/w/mine/members/user-7?tab=activity');

    const feed = await screen.findByRole('list', { name: 'Activity' });
    const rows = within(feed).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('commented on');
    expect(rows[0]).toHaveTextContent('Pricing copy is ready');
    expect(rows[1]).toHaveTextContent('created the issue');
    expect(
      within(feed).getByRole('link', { name: /Ship the pricing page/ })
    ).toHaveAttribute('href', '/w/mine/issues/WEB-4');
    expect(listIssues).not.toHaveBeenCalled();
  });

  it('says so when there is no activity the viewer can see', async () => {
    listMemberActivity.mockResolvedValue({ activity: [], next_cursor: null });
    renderPage('/w/mine/members/user-7?tab=activity');

    expect(
      await screen.findByText('No recent activity you can see.')
    ).toBeInTheDocument();
  });

  it('reads as not found for someone outside the workspace', async () => {
    getMemberProfile.mockRejectedValue(
      new ApiError({
        status: 404,
        statusText: 'Not Found',
        body: { error_code: 'NOT_FOUND', message: 'Not found' },
        url: '/api/workspaces/ws-1/views/members/user-9',
        method: 'GET',
      })
    );
    renderPage('/w/mine/members/user-9');

    expect(
      await screen.findByText('This person is not a member of this workspace.')
    ).toBeInTheDocument();
    expect(listIssues).not.toHaveBeenCalled();
  });
});
