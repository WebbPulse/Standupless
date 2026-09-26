/**
 * A saved view's page. Covers opening the view as its stored layout and
 * filters, the controls that appear once something changed on top of it,
 * saving over the view with its fixed scope kept, and saving as a new one.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
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
import type { SavedViewDisplayRead } from '../../api/views';
import ViewDetail from './ViewDetail';

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
const getView = vi.fn<(id: string) => Promise<SavedViewDisplayRead>>();
const updateView =
  vi.fn<(id: string, body: Record<string, unknown>) => Promise<unknown>>();

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
    getView: (_w: string, id: string) => getView(id),
    updateView: (_w: string, id: string, body: Record<string, unknown>) =>
      updateView(id, body),
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

/** A team board view of the high priority issues, grouped by status. */
const view: SavedViewDisplayRead = {
  view_id: 'view-1',
  workspace_id: 'ws-1',
  name: 'Hot board',
  kind: 'board',
  scope: 'team',
  team_id: 'team-1',
  filter: { team_id: 'team-1', priority: ['high'] },
  sort: 'priority_desc',
  group_by: 'status',
  owner_id: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  layout: 'board',
  sub_group_by: null,
  ordering: null,
  visible_properties: null,
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
const renderPage = (path = '/w/mine/views/view-1', extra?: ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <PeekProvider>
          <CreateIssueContext.Provider value={creator}>
            <Routes>
              <Route path="/w/:slug/views/:viewId" element={<ViewDetail />} />
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
    getView,
    updateView,
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
  getView.mockResolvedValue(view);
  updateView.mockResolvedValue({ ...view, updated_at: '2026-09-18T00:00:00Z' });
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

describe('a saved view', () => {
  it('opens as its stored layout and runs its stored filter', async () => {
    renderPage();

    expect(await screen.findByText('Hot board')).toBeInTheDocument();
    expect(
      await screen.findByRole('list', { name: 'Todo' })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: 'team-1', priority: ['high'] })
      );
    });
    expect(
      screen.getByRole('button', { name: /Priority is, switch/ })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Views' })).not.toHaveLength(0);
    expect(
      screen.queryByRole('button', { name: 'Update view' })
    ).not.toBeInTheDocument();
  });

  it('saves changes over the view, keeping its team scope', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/views/view-1?layout=list&group=assignee');

    await user.click(
      await screen.findByRole('button', { name: 'Update view' })
    );

    await waitFor(() => {
      expect(updateView).toHaveBeenCalledWith(
        'view-1',
        expect.objectContaining({
          filter: { team_id: 'team-1', priority: ['high'] },
          layout: 'list',
          group_by: 'assignee',
        })
      );
    });
  });

  it('saves changes as a new view', async () => {
    const user = userEvent.setup();
    createView.mockResolvedValue({ view_id: 'view-2', name: 'Hot board copy' });
    renderPage('/w/mine/views/view-1?f=priority.is:low');

    await user.click(
      await screen.findByRole('button', { name: 'Save as new' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('View name')).toHaveValue(
      'Hot board copy'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(createView).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Hot board copy',
          kind: 'board',
          filter: { team_id: 'team-1', priority: ['low'] },
        })
      );
    });
  });

  it('puts the view back as saved with Reset', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/views/view-1?layout=list');

    await user.click(await screen.findByRole('button', { name: 'Reset' }));

    expect(
      await screen.findByRole('list', { name: 'Todo' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Update view' })
    ).not.toBeInTheDocument();
  });

  it('surfaces a view that cannot be read', async () => {
    getView.mockRejectedValue(new Error('gone'));
    renderPage();

    expect(
      await screen.findByText('Could not load the view.')
    ).toBeInTheDocument();
  });
});
