/**
 * The one-off key list. Covers parsing a `:key` segment into keys, that one
 * key still opens the issue page while several open the list, that the list
 * reads every key across teams in one request, shows the rows in the order
 * named, counts the keys that named nothing, and saves a view over the issue
 * ids the keys resolved to.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../api/issues';
import type { SavedViewDisplayRead } from '../../api/views';
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
import IssueDetail from './IssueDetail';
import { KEY_LIST_MAX, notFoundNote, parseIssueKeys } from './IssueKeyList';

const listIssues =
  vi.fn<(query: Record<string, unknown>) => Promise<IssueListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<(teamId: string) => Promise<StatusRead[]>>();
const createView =
  vi.fn<(body: Record<string, unknown>) => Promise<SavedViewDisplayRead>>();

vi.mock('../../components/issues/IssueView', () => ({
  default: ({ issueRef }: { issueRef: string }) => (
    <p>Issue page for {issueRef}</p>
  ),
}));

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
  return {
    ...actual,
    listViews: () => Promise.resolve([]),
    createView: (_w: string, body: Record<string, unknown>) => createView(body),
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

/** An issue with the given fields. */
const issue = (fields: Partial<OrderedIssueRead>): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'team-1-todo',
  priority: 'low',
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
  sort_order: 'a0',
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
    status_id: 'team-2-done',
    priority: 'urgent',
    sort_order: 'a1',
  }),
  issue({
    id: 'iss-3',
    key: 'ENG-3',
    number: 3,
    title: 'Retire the old cache',
    priority: 'high',
    sort_order: 'a2',
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

/** Mounts the issue route at the given address inside the shell's providers. */
const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <PeekProvider>
          <CreateIssueContext.Provider value={creator}>
            <Routes>
              <Route path="/w/:slug/issues/:key" element={<IssueDetail />} />
            </Routes>
          </CreateIssueContext.Provider>
        </PeekProvider>
      </ShortcutProvider>
    </MemoryRouter>
  );

const KEYS = ['ENG-1', 'WEB-4', 'ENG-3'];

/** The issue keys the list's row links open, top to bottom, each once. */
const shownKeys = (): string[] => {
  const shown: string[] = [];
  for (const link of screen.getAllByRole('link')) {
    const key = (link.getAttribute('href') ?? '').split('/').pop() ?? '';
    if (KEYS.includes(key) && !shown.includes(key)) shown.push(key);
  }
  return shown;
};

beforeEach(() => {
  listIssues.mockReset();
  listTeams.mockReset();
  listStatuses.mockReset();
  createView.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listTeams.mockResolvedValue(teams);
  listStatuses.mockImplementation((teamId) =>
    Promise.resolve(statusesFor(teamId))
  );
  listIssues.mockResolvedValue({ issues, next_cursor: null });
});

describe('parseIssueKeys', () => {
  it('splits on commas, trims, upper-cases and keeps each key once', () => {
    expect(parseIssueKeys(' eng-3, WEB-4,,ENG-3 ,eng-1')).toEqual([
      'ENG-3',
      'WEB-4',
      'ENG-1',
    ]);
  });

  it('reads one key as one key', () => {
    expect(parseIssueKeys('ENG-1')).toEqual(['ENG-1']);
    expect(parseIssueKeys('ENG-1,')).toEqual(['ENG-1']);
  });

  it('stops at the list ceiling', () => {
    const many = Array.from({ length: KEY_LIST_MAX + 5 }, (_, i) => `ENG-${i}`);
    expect(parseIssueKeys(many.join(','))).toHaveLength(KEY_LIST_MAX);
  });
});

describe('notFoundNote', () => {
  it('says nothing when every key was found', () => {
    expect(notFoundNote(0)).toBeNull();
  });

  it('counts the keys that were skipped', () => {
    expect(notFoundNote(1)).toBe('1 key was not found.');
    expect(notFoundNote(3)).toBe('3 keys were not found.');
  });
});

describe('the issue key route', () => {
  it('opens the issue page for one key', async () => {
    renderAt('/w/mine/issues/ENG-1');

    expect(await screen.findByText('Issue page for ENG-1')).toBeInTheDocument();
    expect(listIssues).not.toHaveBeenCalled();
  });

  it('reads several keys across teams in one request', async () => {
    renderAt('/w/mine/issues/ENG-3,web-4,ENG-1,ZZZ-9');

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ key: ['ENG-3', 'WEB-4', 'ENG-1', 'ZZZ-9'] })
      );
    });
    expect(listIssues).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Issue page for/)).not.toBeInTheDocument();
  });

  it('lists the rows in the order the keys name them', async () => {
    renderAt('/w/mine/issues/ENG-3,WEB-4,ENG-1');

    await screen.findByText('Retire the old cache');
    await waitFor(() => {
      expect(shownKeys()).toEqual(['ENG-3', 'WEB-4', 'ENG-1']);
    });
    expect(screen.getAllByText('3 issues').length).toBeGreaterThan(0);
  });

  it('quietly counts the keys that named nothing', async () => {
    renderAt('/w/mine/issues/ENG-3,ZZZ-9,WEB-4,ENG-1,ENG-404');

    expect(
      await screen.findByText('2 keys were not found.')
    ).toBeInTheDocument();
  });

  it('says so when no key names an issue', async () => {
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
    renderAt('/w/mine/issues/ZZZ-1,ZZZ-2');

    expect(
      await screen.findByText('None of these keys name an issue you can see.')
    ).toBeInTheDocument();
  });

  it('saves a view over the issue ids the keys resolved to', async () => {
    const user = userEvent.setup();
    createView.mockResolvedValue({
      view_id: 'view-9',
      name: 'Launch blockers',
    } as SavedViewDisplayRead);
    renderAt('/w/mine/issues/ENG-3,WEB-4,ENG-1');

    await screen.findByText('Retire the old cache');
    await user.click(screen.getByRole('button', { name: 'Save as view' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('View name'),
      'Launch blockers'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(createView).toHaveBeenCalled();
    });
    const [body] = createView.mock.calls[0] ?? [];
    const filter = (body?.['filter'] ?? {}) as Record<string, unknown>;
    expect(filter['key']).toBeUndefined();
    expect(
      [...((filter['issue_id'] as string[] | undefined) ?? [])].sort()
    ).toEqual(['iss-1', 'iss-2', 'iss-3']);
  });

  it('opens Save as view on Option or Alt+V but not while typing', async () => {
    renderAt('/w/mine/issues/ENG-3,WEB-4,ENG-1');
    await screen.findByText('Retire the old cache');

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: '\u221a', code: 'KeyV', altKey: true });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    field.remove();

    fireEvent.keyDown(document.body, {
      key: 'V',
      code: 'KeyV',
      shiftKey: true,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.keyDown(document.body, {
      key: '\u221a',
      code: 'KeyV',
      altKey: true,
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('View name')).toBeInTheDocument();
  });
});
