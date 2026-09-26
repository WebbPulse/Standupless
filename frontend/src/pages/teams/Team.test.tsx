/**
 * The team page. Covers resolving the key prefix, the grouped list it opens
 * on, filters and display carried in the URL, the keyboard walk and bulk
 * edit, peeking, creating from the page and saving what is on screen as a
 * view. The settings sections have their own route and tests.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../api/issues';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import { PeekPane, PeekProvider } from '../../components/workspace/PeekPane';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import type {
  IssueListRead,
  LabelRead,
  StatusRead,
  TeamMemberRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Team from './Team';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const listTeamMembers = vi.fn<() => Promise<TeamMemberRead[]>>();
const listIssues =
  vi.fn<(query: Record<string, unknown>) => Promise<IssueListRead>>();
const updateIssue =
  vi.fn<(id: string, body: unknown) => Promise<OrderedIssueRead>>();
const bulkUpdateIssues =
  vi.fn<
    (body: {
      issue_ids: string[];
      patch: unknown;
    }) => Promise<{ issues: OrderedIssueRead[] }>
  >();
const createView = vi.fn<(body: Record<string, unknown>) => Promise<unknown>>();

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
    updateIssue: (_w: string, id: string, body: unknown) =>
      updateIssue(id, body),
    bulkUpdateIssues: (
      _w: string,
      body: { issue_ids: string[]; patch: unknown }
    ) => bulkUpdateIssues(body),
  };
});

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => listStatuses(),
  listLabels: () => listLabels(),
  listTeamMembers: () => listTeamMembers(),
  createLabel: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
}));

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    listViews: () => Promise.resolve([]),
    createView: (_w: string, body: Record<string, unknown>) => createView(body),
  };
});

vi.mock('../../components/issues/IssuePeek', () => ({
  default: ({ issueId }: { issueId: string }) => (
    <aside aria-label={`Peek ${issueId}`} />
  ),
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

const team: TeamRead = {
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

const statuses: StatusRead[] = [
  { id: 'st-todo', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'st-doing', name: 'Doing', category: 'started', position: 1 },
  { id: 'st-done', name: 'Done', category: 'completed', position: 2 },
];

/** An issue in the team with the given fields. */
const issue = (fields: Partial<OrderedIssueRead>): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-todo',
  priority: 'high',
  assignee_id: null,
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
  issue({ id: 'iss-1', key: 'ENG-1', number: 1, title: 'Cache the token' }),
  issue({
    id: 'iss-2',
    key: 'ENG-2',
    number: 2,
    title: 'Rotate keys',
    status_id: 'st-doing',
  }),
  issue({
    id: 'iss-3',
    key: 'ENG-3',
    number: 3,
    title: 'Write docs',
    priority: 'low',
  }),
];

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

const openCreate = vi.fn();

/** A create dialog state that records what the page asked for. */
const creator: CreateIssueState = {
  open: openCreate,
  close: vi.fn(),
  isOpen: false,
  canCreate: true,
  request: null,
};

/** Mounts the team route inside the shell's providers. */
const renderPage = (path = '/w/mine/team/ENG', extra?: ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <PeekProvider>
          <CreateIssueContext.Provider value={creator}>
            <Routes>
              <Route path="/w/:slug/team/:keyPrefix" element={<Team />} />
              <Route path="/w/:slug/views/:viewId" element={<p>View page</p>} />
              <Route
                path="/w/:slug/issues/:issueKey"
                element={<p>Issue page</p>}
              />
            </Routes>
            <PeekPane />
            {extra}
          </CreateIssueContext.Provider>
        </PeekProvider>
      </ShortcutProvider>
    </MemoryRouter>
  );

/** Presses a key on the document, as the shortcut layer hears it. */
const press = (key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...init })
    );
  });
};

/** The row element of an issue. */
const row = (id: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
  if (found === null) throw new Error(`no row for ${id}`);
  return found;
};

beforeEach(() => {
  for (const spy of [
    listTeams,
    listStatuses,
    listLabels,
    listTeamMembers,
    listIssues,
    updateIssue,
    bulkUpdateIssues,
    createView,
    openCreate,
  ]) {
    spy.mockReset();
  }
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
  listTeams.mockResolvedValue([team]);
  listStatuses.mockResolvedValue(statuses);
  listLabels.mockResolvedValue([]);
  listTeamMembers.mockResolvedValue([]);
  listIssues.mockResolvedValue({ issues, next_cursor: null });
  updateIssue.mockImplementation((id, body) =>
    Promise.resolve({
      ...issues.find((item) => item.id === id),
      ...(body as object),
    } as OrderedIssueRead)
  );
  bulkUpdateIssues.mockImplementation(({ issue_ids, patch }) =>
    Promise.resolve({
      issues: issues
        .filter((item) => issue_ids.includes(item.id))
        .map((item) => ({ ...item, ...(patch as object) })),
    })
  );
});

describe('resolving the team', () => {
  it('shows the team the key prefix names', async () => {
    renderPage();

    expect(await screen.findByText('Engine')).toBeInTheDocument();
  });

  it('says so when no team in the workspace uses that key', async () => {
    renderPage('/w/mine/team/NOPE');

    expect(await screen.findByText('Team not found')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listTeams.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load this team.')
    ).toBeInTheDocument();
  });
});

describe('the list', () => {
  it('reads this team only and groups rows by status with counts', async () => {
    renderPage();

    const todo = await screen.findByRole('region', { name: 'Todo' });
    expect(within(todo).getByText('Cache the token')).toBeInTheDocument();
    expect(within(todo).getByText('Write docs')).toBeInTheDocument();
    expect(
      within(todo).getByRole('button', { name: /Todo\s*2/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Doing' })).toBeInTheDocument();
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 'team-1', sort: 'priority_desc' })
    );
  });

  it('collapses a group from its header', async () => {
    const user = userEvent.setup();
    renderPage();

    const todo = await screen.findByRole('region', { name: 'Todo' });
    await user.click(within(todo).getByRole('button', { name: /^Todo/ }));

    expect(within(todo).queryByText('Cache the token')).not.toBeInTheDocument();
  });

  it('runs the filters and grouping the URL carries', async () => {
    renderPage('/w/mine/team/ENG?f=priority.not:low&group=priority');

    expect(
      await screen.findByRole('region', { name: 'High' })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: 'team-1', priority_not: ['low'] })
      );
    });
    expect(
      screen.getByRole('button', { name: /Priority is not, switch/ })
    ).toBeInTheDocument();
  });

  it('offers the first issue when the team has none', async () => {
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
    renderPage();

    expect(
      await screen.findByText(
        'No issues in this team yet. Create the first one to get started.'
      )
    ).toBeInTheDocument();
    const empty = screen
      .getByText(
        'No issues in this team yet. Create the first one to get started.'
      )
      .closest('div');
    if (empty === null) throw new Error('no empty state');
    expect(within(empty).getByText('C')).toBeInTheDocument();
    fireEvent.click(
      within(empty).getByRole('button', { name: 'Create issue' })
    );
    expect(openCreate).toHaveBeenCalledWith({ teamId: 'team-1' });
  });
});

describe('the keyboard', () => {
  it('walks rows, selects them and edits them together', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    press('j');
    expect(row('iss-1')).toHaveClass('before:bg-accent');
    press('x');
    press('j');
    press('x');

    expect(
      screen.getByRole('toolbar', { name: 'Selected issues' })
    ).toHaveTextContent('2 selected');

    press('p');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('option', { name: /Urgent/ }));

    await waitFor(() => {
      expect(bulkUpdateIssues).toHaveBeenCalledWith({
        issue_ids: expect.arrayContaining(['iss-1', 'iss-3']) as string[],
        patch: { priority: 'urgent' },
      });
    });
  });

  it('changes the focused row alone with a single patch', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    press('j');
    press('s');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('option', { name: /Done/ }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        status_id: 'st-done',
      });
    });
  });

  it('peeks the focused row with Space and opens it with Enter', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    press('j');
    press(' ');
    expect(
      await screen.findAllByRole('complementary', { name: 'Peek iss-1' })
    ).not.toHaveLength(0);

    press('Enter');
    expect(await screen.findByText('Issue page')).toBeInTheDocument();
  });

  it('clears the selection with Escape', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    press('j');
    press('x');
    expect(
      screen.getByRole('toolbar', { name: 'Selected issues' })
    ).toBeInTheDocument();

    press('Escape');
    expect(
      screen.queryByRole('toolbar', { name: 'Selected issues' })
    ).not.toBeInTheDocument();
  });
});

describe('creating and saving', () => {
  it('opens the create dialog on this team', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New issue' }));

    expect(openCreate).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1' })
    );
  });

  it('hides creating from a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...guestTeam } = team;
    listTeams.mockResolvedValue([guestTeam]);
    renderPage();

    await screen.findByText('Engine');
    expect(
      screen.queryByRole('button', { name: 'New issue' })
    ).not.toBeInTheDocument();
  });

  it('offers to save only once something changed, and saves it as a team view', async () => {
    const user = userEvent.setup();
    createView.mockResolvedValue({ view_id: 'view-9', name: 'Urgent work' });
    renderPage('/w/mine/team/ENG?group=priority');

    await user.click(await screen.findByRole('button', { name: 'Save view' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('View name'), 'Urgent work');
    await user.click(within(dialog).getByLabelText('Share with Engine'));
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(createView).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Urgent work',
          kind: 'list',
          team_id: 'team-1',
          group_by: 'priority',
          filter: { team_id: 'team-1' },
        })
      );
    });
    expect(await screen.findByText('View page')).toBeInTheDocument();
  });

  it('has no save button while the list is as the page opens', async () => {
    renderPage();

    await screen.findByText('Cache the token');
    expect(
      screen.queryByRole('button', { name: 'Save view' })
    ).not.toBeInTheDocument();
  });
});
