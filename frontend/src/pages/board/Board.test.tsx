/**
 * The board page. Covers the columns it opens on, dragging a card to another
 * column to change its status, dragging within a column to set a manual
 * order, swimlanes when rows are sub-grouped, and the keyboard walking cards
 * in board order.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
import Board from './Board';

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
const renderPage = (path = '/w/mine/team/ENG/board', extra?: ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <PeekProvider>
          <CreateIssueContext.Provider value={creator}>
            <Routes>
              <Route
                path="/w/:slug/team/:keyPrefix/board"
                element={<Board />}
              />
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

/** A drag payload jsdom accepts. */
const transfer = () => ({
  setData: vi.fn(),
  effectAllowed: '',
  dropEffect: '',
});

/** Drags one card onto a column or another card. */
const dragTo = (card: HTMLElement, onto: HTMLElement, below = false) => {
  const data = transfer();
  fireEvent.dragStart(card, { dataTransfer: data });
  vi.spyOn(onto, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    height: 40,
    bottom: 40,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent.dragOver(onto, { dataTransfer: data, clientY: below ? 30 : 5 });
  fireEvent.drop(onto.closest('ul') ?? onto, { dataTransfer: data });
};

describe('the board', () => {
  it('opens with a column per status, empty ones included', async () => {
    renderPage();

    const todo = await screen.findByRole('list', { name: 'Todo' });
    expect(within(todo).getByText('Cache the token')).toBeInTheDocument();
    expect(within(todo).getByText('Write docs')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Doing' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Done' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('moves a card to another column by changing its status', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    dragTo(row('iss-1'), screen.getByRole('list', { name: 'Done' }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        status_id: 'st-done',
      });
    });
    expect(
      within(screen.getByRole('list', { name: 'Done' })).getByText(
        'Cache the token'
      )
    ).toBeInTheDocument();
  });

  it('reorders within a column by setting a manual position', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    dragTo(row('iss-3'), row('iss-1'));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith(
        'iss-3',
        expect.objectContaining({ sort_order: expect.any(String) as string })
      );
    });
    const todo = screen.getByRole('list', { name: 'Todo' });
    const titles = within(todo)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(titles).toEqual(['Write docs', 'Cache the token']);
  });

  it('leaves a card dropped where it already sits alone', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    dragTo(row('iss-1'), row('iss-1'));

    expect(updateIssue).not.toHaveBeenCalled();
    expect(bulkUpdateIssues).not.toHaveBeenCalled();
  });

  it('draws swimlanes when rows are sub-grouped', async () => {
    renderPage('/w/mine/team/ENG/board?sub=priority');

    expect(
      await screen.findByRole('list', { name: 'Todo, High' })
    ).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Todo, Low' })).toBeInTheDocument();
  });

  it('walks the cards with the keyboard and peeks the focused one', async () => {
    renderPage();
    await screen.findByText('Cache the token');

    press('j');
    press('j');
    press(' ');

    expect(
      await screen.findAllByRole('complementary', { name: 'Peek iss-3' })
    ).not.toHaveLength(0);
  });
});
