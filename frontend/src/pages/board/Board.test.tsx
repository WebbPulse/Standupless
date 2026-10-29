/**
 * The board page. Covers the columns it opens on, dragging a card to another
 * column to change its status, dragging within a column to set a manual
 * order, dragging a selection in one move, dropping on a hidden column,
 * previewing a hidden column's issues from the rail, opening or peeking one
 * from there and showing the column again, empty columns joining the rail
 * when empty groups are off,
 * swimlanes when rows are sub-grouped, and the keyboard walking cards in
 * board order.
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
import { BoundKeys } from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import { clearToasts, currentToasts } from '../../lib/toast';
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
  getDisplayDefaults: () =>
    Promise.resolve({
      team_id: 'team-1',
      list_display: null,
      board_display: null,
      updated_by: null,
      updated_at: null,
    }),
  updateDisplayDefaults: vi.fn(),
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

/** Hides a board column from its header menu. */
const hideColumn = async (name: string) => {
  fireEvent.click(
    screen.getByRole('button', { name: `${name} column options` })
  );
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Hide column' }));
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
  clearToasts();
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

/** Adds a card to the selection the way a shift click on its title does. */
const select = (title: string) => {
  fireEvent.click(screen.getByRole('link', { name: title }), {
    shiftKey: true,
  });
};

/** The messages of the notices on screen. */
const toastMessages = (): string[] =>
  currentToasts().map((toast) => toast.message);

/** The titles of the cards in a cell, top to bottom. */
const titlesIn = (name: string): (string | null)[] =>
  within(screen.getByRole('list', { name }))
    .getAllByRole('link')
    .map((link) => link.textContent);

describe('dragging a selection', () => {
  it('moves every selected card to another column in one write', async () => {
    renderPage();
    await screen.findByText('Cache the token');
    select('Cache the token');
    select('Write docs');

    dragTo(row('iss-1'), screen.getByRole('list', { name: 'Done' }));

    await waitFor(() => {
      expect(bulkUpdateIssues).toHaveBeenCalledTimes(1);
    });
    expect(bulkUpdateIssues).toHaveBeenCalledWith({
      issue_ids: ['iss-1', 'iss-3'],
      patch: { status_id: 'st-done' },
    });
    expect(updateIssue).not.toHaveBeenCalled();
    expect(titlesIn('Done')).toEqual(['Cache the token', 'Write docs']);
    await waitFor(() => {
      expect(toastMessages()).toContain('Moved 2 issues to Done');
    });
  });

  it('sets the lane property too when the selection lands in another lane', async () => {
    renderPage('/w/mine/team/ENG/board?sub=priority');
    await screen.findByRole('list', { name: 'Todo, High' });
    select('Cache the token');
    select('Rotate keys');

    dragTo(row('iss-1'), screen.getByRole('list', { name: 'Done, Low' }));

    await waitFor(() => {
      expect(bulkUpdateIssues).toHaveBeenCalledTimes(1);
    });
    const [call] = bulkUpdateIssues.mock.calls[0] ?? [];
    expect([...(call?.issue_ids ?? [])].sort()).toEqual(['iss-1', 'iss-2']);
    expect(call?.patch).toEqual({ status_id: 'st-done', priority: 'low' });
    expect([...titlesIn('Done, Low')].sort()).toEqual([
      'Cache the token',
      'Rotate keys',
    ]);
    await waitFor(() => {
      expect(toastMessages()).toContain('Moved 2 issues to Done, Low');
    });
  });

  it('places the selection together between two cards in manual order', async () => {
    const served = new Map<string, object>();
    bulkUpdateIssues.mockImplementation(({ issue_ids, patch }) => {
      for (const id of issue_ids) {
        served.set(id, { ...served.get(id), ...(patch as object) });
      }
      return Promise.resolve({
        issues: issues
          .filter((item) => issue_ids.includes(item.id))
          .map((item) => ({ ...item, ...served.get(item.id) })),
      });
    });
    updateIssue.mockImplementation((id, body) =>
      Promise.resolve({
        ...issues.find((item) => item.id === id),
        ...served.get(id),
        ...(body as object),
      } as OrderedIssueRead)
    );
    renderPage('/w/mine/team/ENG/board?order=manual');
    await screen.findByText('Cache the token');
    select('Rotate keys');
    select('Write docs');

    dragTo(row('iss-2'), row('iss-1'));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledTimes(2);
    });
    const keys = new Map(
      updateIssue.mock.calls.map(([id, body]) => [
        id,
        (body as { sort_order?: string }).sort_order,
      ])
    );
    expect(keys.get('iss-2')).toEqual(expect.any(String));
    expect(keys.get('iss-3')).toEqual(expect.any(String));
    expect((keys.get('iss-2') ?? '') < (keys.get('iss-3') ?? '')).toBe(true);
    expect(bulkUpdateIssues).toHaveBeenCalledWith({
      issue_ids: ['iss-2'],
      patch: { status_id: 'st-todo' },
    });
    expect(titlesIn('Todo')).toEqual([
      'Rotate keys',
      'Write docs',
      'Cache the token',
    ]);
  });

  it('moves only an unselected card dragged while others are selected', async () => {
    renderPage();
    await screen.findByText('Cache the token');
    select('Cache the token');
    select('Write docs');

    dragTo(row('iss-2'), screen.getByRole('list', { name: 'Done' }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-2', {
        status_id: 'st-done',
      });
    });
    expect(bulkUpdateIssues).not.toHaveBeenCalled();
    expect(row('iss-1')).toHaveAttribute('aria-selected', 'true');
    expect(row('iss-3')).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the lead card with a count badge as the drag image', async () => {
    renderPage();
    await screen.findByText('Cache the token');
    select('Cache the token');
    select('Write docs');
    const setDragImage = vi.fn();

    fireEvent.dragStart(row('iss-3'), {
      dataTransfer: { ...transfer(), setDragImage },
    });

    expect(setDragImage).toHaveBeenCalledTimes(1);
    const ghost = setDragImage.mock.calls[0]?.[0] as HTMLElement;
    expect(ghost.textContent).toContain('Write docs');
    expect(ghost.querySelector('[data-drag-count]')?.textContent).toBe(
      '2 issues'
    );
  });

  it('sets a hidden column by a drop on the rail without showing it', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Done' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Done column options' })
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Hide column' })
    );
    select('Cache the token');
    select('Write docs');
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    const done = within(rail).getByRole('button', { name: /Done/ });
    const data = transfer();

    fireEvent.dragStart(row('iss-1'), { dataTransfer: data });
    fireEvent.dragOver(done, { dataTransfer: data });
    expect(done).toHaveAttribute('data-drop-target');
    fireEvent.drop(done, { dataTransfer: data });

    await waitFor(() => {
      expect(bulkUpdateIssues).toHaveBeenCalledWith({
        issue_ids: ['iss-1', 'iss-3'],
        patch: { status_id: 'st-done' },
      });
    });
    expect(
      screen.queryByRole('list', { name: 'Done' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
  });
});

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

  it('draws a card sized placeholder where a dragged card would land', async () => {
    renderPage();
    await screen.findByText('Cache the token');
    const card = row('iss-1');
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 64,
      bottom: 64,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const data = transfer();
    fireEvent.dragStart(card, { dataTransfer: data });

    const done = screen.getByRole('list', { name: 'Done' });
    fireEvent.dragOver(done, { dataTransfer: data });

    const placeholder = done.querySelector('[data-drop-placeholder]');
    expect(placeholder).not.toBeNull();
    expect((placeholder as HTMLElement).style.height).toBe('64px');

    fireEvent.dragEnd(card);
    expect(document.querySelector('[data-drop-placeholder]')).toBeNull();
  });

  it('draws no placeholder over the dragged card itself', async () => {
    renderPage();
    await screen.findByText('Cache the token');
    const card = row('iss-1');
    const data = transfer();
    fireEvent.dragStart(card, { dataTransfer: data });
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
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
    fireEvent.dragOver(card, { dataTransfer: data, clientY: 5 });

    expect(document.querySelector('[data-drop-placeholder]')).toBeNull();
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

  it('hides a column into the rail and brings it back', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Doing' });

    fireEvent.click(
      screen.getByRole('button', { name: 'Doing column options' })
    );
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Hide column' })
    );

    expect(
      screen.queryByRole('list', { name: 'Doing' })
    ).not.toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    fireEvent.click(within(rail).getByRole('button', { name: /Doing/ }));
    const preview = await screen.findByRole('dialog', {
      name: 'Doing issues',
    });
    fireEvent.click(
      within(preview).getByRole('button', { name: 'Show column' })
    );

    expect(screen.getByRole('list', { name: 'Doing' })).toBeInTheDocument();
    expect(
      screen.queryByRole('complementary', { name: 'Hidden columns' })
    ).not.toBeInTheDocument();
  });

  it('previews a hidden column from the rail and walks it with the keys', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Todo' });
    await hideColumn('Todo');

    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    fireEvent.click(within(rail).getByRole('button', { name: /Todo/ }));
    const preview = await screen.findByRole('dialog', { name: 'Todo issues' });
    const first = within(preview).getByRole('link', {
      name: /Cache the token/,
    });
    const second = within(preview).getByRole('link', { name: /Write docs/ });
    const show = within(preview).getByRole('button', { name: 'Show column' });

    expect(first).toHaveTextContent('ENG-1');
    expect(first).toHaveAttribute('href', '/w/mine/issues/ENG-1');
    expect(
      screen.queryByRole('list', { name: 'Todo' })
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
    fireEvent.keyDown(first, { key: 'j' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(show).toHaveFocus();
    fireEvent.keyDown(show, { key: 'k' });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'Escape' });
    expect(
      screen.queryByRole('dialog', { name: 'Todo issues' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Todo' })
    ).not.toBeInTheDocument();
  });

  it('opens an issue from a hidden column preview', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Todo' });
    await hideColumn('Todo');

    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    fireEvent.click(within(rail).getByRole('button', { name: /Todo/ }));
    const preview = await screen.findByRole('dialog', { name: 'Todo issues' });
    fireEvent.click(within(preview).getByRole('link', { name: /Write docs/ }));

    expect(await screen.findByText('Issue page')).toBeInTheDocument();
  });

  it('peeks an issue from a hidden column preview with Space', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Todo' });
    await hideColumn('Todo');

    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    fireEvent.click(within(rail).getByRole('button', { name: /Todo/ }));
    const preview = await screen.findByRole('dialog', { name: 'Todo issues' });
    fireEvent.keyDown(
      within(preview).getByRole('link', { name: /Cache the token/ }),
      { key: ' ' }
    );

    expect(
      await screen.findAllByRole('complementary', { name: 'Peek iss-1' })
    ).not.toHaveLength(0);
    expect(
      screen.queryByRole('dialog', { name: 'Todo issues' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Todo' })
    ).not.toBeInTheDocument();
  });

  it('opens no preview from an empty column in the rail', async () => {
    renderPage('/w/mine/team/ENG/board?empty=0');
    await screen.findByRole('list', { name: 'Todo' });
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });

    fireEvent.click(within(rail).getByTitle(/^Done is empty/));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lists empty columns in the rail when empty groups are off', async () => {
    renderPage('/w/mine/team/ENG/board?empty=0');
    await screen.findByRole('list', { name: 'Todo' });

    expect(
      screen.queryByRole('list', { name: 'Done' })
    ).not.toBeInTheDocument();
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    const done = within(rail).getByTitle(/^Done is empty/);
    expect(done).toHaveAttribute('data-empty-column');
    expect(within(done).getByText('Done')).toBeInTheDocument();
    expect(
      within(rail).queryByRole('button', { name: /Done/ })
    ).not.toBeInTheDocument();
    expect(within(rail).queryByText('Doing')).not.toBeInTheDocument();
  });

  it('keeps the rail to hidden columns while empty groups show', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Done' });

    expect(
      screen.queryByRole('complementary', { name: 'Hidden columns' })
    ).not.toBeInTheDocument();
  });

  it('fills an empty column by a drop on the rail and brings it onto the board', async () => {
    renderPage('/w/mine/team/ENG/board?empty=0');
    await screen.findByText('Cache the token');
    const rail = screen.getByRole('complementary', { name: 'Hidden columns' });
    const done = within(rail).getByTitle(/^Done is empty/);
    const data = transfer();

    fireEvent.dragStart(row('iss-1'), { dataTransfer: data });
    fireEvent.dragOver(done, { dataTransfer: data });
    expect(done).toHaveAttribute('data-drop-target');
    fireEvent.drop(done, { dataTransfer: data });

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        status_id: 'st-done',
      });
    });
    expect(
      within(await screen.findByRole('list', { name: 'Done' })).getByText(
        'Cache the token'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('complementary', { name: 'Hidden columns' })
    ).not.toBeInTheDocument();
  });

  it('walks the cards with the keyboard and peeks the focused one', async () => {
    renderPage(undefined, <BoundKeys />);
    await screen.findByText('Cache the token');
    await keysBound('j');

    press('j');
    press('j');
    await keysBound('space');
    press(' ');

    expect(
      await screen.findAllByRole('complementary', { name: 'Peek iss-3' })
    ).not.toHaveLength(0);
  });
});
