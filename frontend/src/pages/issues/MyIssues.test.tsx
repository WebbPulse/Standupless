/**
 * The cross-team "my issues" page. Covers that the read is fixed to the
 * caller with `assignee_id=me` and spans teams, that rows group by status and
 * name their team, that the assignee filter is left out because the page
 * fixes it, that the display options hide sub-issues and completed issues,
 * that the Created and Subscribed tabs read by creator and subscriber, and the
 * empty and failed states.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  StatusRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import MyIssues from './MyIssues';

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

/** Mounts the page at its route inside the shell's providers. */
const renderPage = (path = '/w/mine/issues') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <PeekProvider>
          <CreateIssueContext.Provider value={creator}>
            <Routes>
              <Route path="/w/:slug/issues" element={<MyIssues />} />
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
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listTeams.mockResolvedValue(teams);
  listStatuses.mockImplementation((teamId) =>
    Promise.resolve(statusesFor(teamId))
  );
  listIssues.mockResolvedValue({ issues, next_cursor: null });
});

describe('my issues', () => {
  it('reads only what is assigned to the caller, across every team', async () => {
    renderPage();

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ assignee_id: 'me' })
      );
    });
    const [query] = listIssues.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('team_id');
  });

  it('groups the rows by status across teams and names each team', async () => {
    renderPage();

    const todo = await screen.findByRole('list', { name: 'Todo' });
    expect(within(todo).getByText('Cache the token')).toBeInTheDocument();
    expect(within(todo).getByText('Ship the pricing page')).toBeInTheDocument();
    expect(within(todo).getAllByText('Web').length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole('list', { name: 'Done' })).getByText(
        'Retire the old cache'
      )
    ).toBeInTheDocument();
  });

  it('links each row at the workspace key route', async () => {
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Ship the pricing page' })
    ).toHaveAttribute('href', '/w/mine/issues/WEB-4');
  });

  it('leaves the assignee out of the filter menu, since the page fixes it', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(
      await screen.findByRole('option', { name: 'Priority' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: 'Assignee' })
    ).not.toBeInTheDocument();
  });

  it('hides sub-issues and completed issues from the display options', async () => {
    renderPage('/w/mine/issues?subs=0&done=0');

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(screen.queryByText('Measure hit rate')).not.toBeInTheDocument();
    expect(screen.queryByText('Retire the old cache')).not.toBeInTheDocument();
  });

  it('says so when nothing is assigned', async () => {
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
    renderPage();

    expect(
      await screen.findByText('Nothing is assigned to you right now.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listIssues.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
  it('reads what the caller created on the Created tab', async () => {
    renderPage('/w/mine/issues?tab=created');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ creator_id: 'me' })
      );
    });
    const [query] = listIssues.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('assignee_id');
    expect(
      await screen.findByRole('link', { name: 'Created' })
    ).toHaveAttribute('aria-current', 'page');
  });

  it('reads what the caller follows on the Subscribed tab', async () => {
    renderPage('/w/mine/issues?tab=subscribed');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ subscriber_id: 'me' })
      );
    });
  });

  it('switches tabs from the toolbar', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    expect(screen.getByRole('link', { name: 'Assigned' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await user.click(screen.getByRole('link', { name: 'Subscribed' }));

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ subscriber_id: 'me' })
      );
    });
  });

  it('offers the assignee filter where the tab does not fix it', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/issues?tab=created');

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    expect(
      await screen.findByRole('option', { name: 'Assignee' })
    ).toBeInTheDocument();
  });

  it('treats an unknown tab as Assigned', async () => {
    renderPage('/w/mine/issues?tab=nope');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ assignee_id: 'me' })
      );
    });
  });
});
