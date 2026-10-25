/**
 * The initiatives list. Covers that rows group by status with their project
 * count and progress, that a member creates an initiative owned by them and
 * lands on it, that an empty workspace explains what an initiative is, and that
 * a guest is told initiatives are for members and offered no way to start one,
 * that sub-initiatives sit indented under their parent and fold away, and
 * that the toolbar filters, orders and arranges the list from the URL and
 * saves the arrangement to the account, that rows filter and group by
 * their lead team, owner, health and target month, that j, k and Enter walk
 * and open the rows and x selects one, and that dragging a row in the manual
 * order stores its new place.
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
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  InitiativeCreate,
  InitiativeListRead,
  InitiativeRead,
  InitiativeUpdate,
  MemberRead,
  TeamRead,
  UserPreferencesUpdate,
  UserRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import Initiatives from './Initiatives';

const listInitiatives = vi.fn<() => Promise<InitiativeListRead>>();
const createInitiative =
  vi.fn<(body: InitiativeCreate) => Promise<InitiativeRead>>();
const updateInitiative =
  vi.fn<(id: string, body: InitiativeUpdate) => Promise<InitiativeRead>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
}));
const updatePreferences =
  vi.fn<(body: UserPreferencesUpdate) => Promise<UserRead>>();

vi.mock('../../api/notifications', () => ({
  updatePreferences: (body: UserPreferencesUpdate) => updatePreferences(body),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: {
      id: 'user-1',
      email: 'ada@example.com',
      display_name: 'Ada Lovelace',
    },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/initiatives', () => ({
  listInitiatives: () => listInitiatives(),
  createInitiative: (_w: string, body: InitiativeCreate) =>
    createInitiative(body),
  updateInitiative: (_w: string, id: string, body: InitiativeUpdate) =>
    updateInitiative(id, body),
}));

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return { ...actual, listMembers: () => listMembers() };
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

/** Builds an initiative with an empty rollup. */
const initiative = (
  id: string,
  name: string,
  overrides: Partial<InitiativeRead> = {}
): InitiativeRead => ({
  initiative_id: id,
  workspace_id: 'ws-1',
  name,
  description: null,
  owner_id: null,
  status: 'planned',
  health: null,
  target_date: null,
  project_ids: [],
  project_count: 0,
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  points: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  project_health: { on_track: 0, at_risk: 0, off_track: 0, none: 0 },
  last_update_at: null,
  update_interval_days: 7,
  update_interval_inherited: true,
  next_update_due_at: null,
  update_due_state: null,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

/** A team an initiative can be led by. */
const team = (id: string, name: string, keyPrefix: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: keyPrefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
});

/** The workspace member who owns things. */
const ada: MemberRead = {
  user_id: 'user-1',
  email: 'ada@example.com',
  display_name: 'Ada Lovelace',
  role: 'admin',
  joined_at: '2026-09-17T00:00:00Z',
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

const renderPage = (search = '') =>
  render(
    <MemoryRouter initialEntries={[`/w/mine/initiatives${search}`]}>
      <Routes>
        <Route path="/w/:slug/initiatives" element={<Initiatives />} />
        <Route
          path="/w/:slug/initiatives/:id"
          element={<p>initiative page</p>}
        />
      </Routes>
    </MemoryRouter>
  );

describe('Initiatives', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listMembers.mockResolvedValue([ada]);
    listTeams.mockResolvedValue([
      team('team-1', 'Platform', 'PLT'),
      team('team-2', 'Growth', 'GRO'),
    ]);
    listInitiatives.mockResolvedValue({ initiatives: [], next_cursor: null });
    updatePreferences.mockResolvedValue({
      id: 'user-1',
      email: 'ada@example.com',
      display_name: 'Ada Lovelace',
    } as UserRead);
  });

  it('groups initiatives by status with their projects and progress', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', {
          status: 'active',
          owner_id: 'user-1',
          project_ids: ['prj-1', 'prj-2'],
          project_count: 2,
          counts: { todo: 1, in_progress: 0, done: 3, cancelled: 0, total: 4 },
        }),
        initiative('ini-2', 'Expand'),
      ],
      next_cursor: null,
    });
    renderPage();

    const active = await screen.findByRole('region', { name: 'Active' });
    expect(within(active).getByRole('link', { name: 'Grow' })).toHaveAttribute(
      'href',
      '/w/mine/initiatives/ini-1'
    );
    expect(within(active).getByText('2 projects')).toBeInTheDocument();
    expect(within(active).getByText('75%')).toBeInTheDocument();
    expect(
      await within(active).findByText('Owner Ada Lovelace')
    ).toBeInTheDocument();
    const planned = screen.getByRole('region', { name: 'Planned' });
    expect(within(planned).getByText('Expand')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Completed' })
    ).not.toBeInTheDocument();
  });

  it('creates an initiative owned by the creator and opens it', async () => {
    createInitiative.mockResolvedValue(initiative('ini-9', 'Launch'));
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'New initiative' })
    );
    await user.type(screen.getByLabelText('Initiative name'), 'Launch');
    await user.type(screen.getByLabelText('Summary'), 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Create initiative' }));

    await waitFor(() => {
      expect(createInitiative).toHaveBeenCalledWith({
        name: 'Launch',
        description: 'Ship it',
        owner_id: 'user-1',
        status: 'planned',
        target_date: null,
      });
    });
    expect(await screen.findByText('initiative page')).toBeInTheDocument();
  });

  it('nests sub-initiatives under their parent and folds them away', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Company goals', { status: 'active' }),
        initiative('ini-2', 'Grow revenue', {
          status: 'active',
          parent_initiative_id: 'ini-1',
        }),
        initiative('ini-3', 'Hire', {
          status: 'planned',
          parent_initiative_id: 'ini-1',
        }),
      ],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    const active = await screen.findByRole('region', { name: 'Active' });
    const links = within(active).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Company goals',
      'Grow revenue',
    ]);
    const planned = screen.getByRole('region', { name: 'Planned' });
    expect(within(planned).getByText('in Company goals')).toBeInTheDocument();

    await user.click(
      within(active).getByRole('button', { name: 'Collapse Company goals' })
    );
    expect(
      within(active).queryByRole('link', { name: 'Grow revenue' })
    ).not.toBeInTheDocument();
    expect(within(active).getByText('1 sub-initiative')).toBeInTheDocument();

    await user.click(
      within(active).getByRole('button', { name: 'Expand Company goals' })
    );
    expect(
      within(active).getByRole('link', { name: 'Grow revenue' })
    ).toBeInTheDocument();
  });

  it('explains initiatives when there are none', async () => {
    renderPage();

    expect(await screen.findByText(/No initiatives yet/)).toBeInTheDocument();
  });

  it('keeps guests out', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    renderPage();

    expect(
      await screen.findByText(
        'Initiatives are open to workspace members, not guests.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New initiative' })
    ).not.toBeInTheDocument();
    expect(listInitiatives).not.toHaveBeenCalled();
  });

  it('filters by status, owner and health from the URL', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', {
          status: 'active',
          owner_id: 'user-1',
          health: 'at_risk',
        }),
        initiative('ini-2', 'Expand', { status: 'active' }),
        initiative('ini-3', 'Hire', { owner_id: 'user-1', health: 'at_risk' }),
      ],
      next_cursor: null,
    });
    renderPage('?status=active&owner=user-1&health=at_risk');

    expect(
      await screen.findByRole('link', { name: 'Grow' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Expand' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Hire' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Status filter: Active' })
    ).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(
      await screen.findByRole('link', { name: 'Expand' })
    ).toBeInTheDocument();
  });

  it('orders by name with sub-initiatives kept under their parent', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Zeta', {
          status: 'active',
          target_date: '2026-11-01',
        }),
        initiative('ini-2', 'Yak', {
          status: 'active',
          target_date: '2026-11-01',
          parent_initiative_id: 'ini-1',
        }),
        initiative('ini-3', 'Xylo', {
          status: 'active',
          parent_initiative_id: 'ini-1',
        }),
        initiative('ini-4', 'Alpha', { status: 'active' }),
      ],
      next_cursor: null,
    });
    renderPage('?order=name');

    const active = await screen.findByRole('region', { name: 'Active' });
    expect(
      within(active)
        .getAllByRole('link')
        .map((link) => link.getAttribute('aria-label'))
    ).toEqual(['Alpha', 'Zeta', 'Xylo', 'Yak']);
  });

  it('hides completed initiatives and properties, saving the arrangement', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', { status: 'active', project_count: 2 }),
        initiative('ini-2', 'Done', { status: 'completed' }),
      ],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByRole('region', { name: 'Completed' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByLabelText('Show completed initiatives'));
    expect(
      screen.queryByRole('region', { name: 'Completed' })
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalledWith({
        initiatives_display: {
          layout: 'list',
          zoom: 'month',
          grouping: 'status',
          order: 'target',
          completed: 'hide',
          columns: 'health,team,owner,projects,start,target,progress',
        },
      });
    });

    await user.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.queryByText('2 projects')).not.toBeInTheDocument();
  });

  it('filters by lead team or no team from the URL', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', { team_id: 'team-1' }),
        initiative('ini-2', 'Expand', { team_id: 'team-2' }),
        initiative('ini-3', 'Hire'),
      ],
      next_cursor: null,
    });
    const { unmount } = renderPage('?team=PLT');

    expect(
      await screen.findByRole('link', { name: 'Grow' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Expand' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Hire' })
    ).not.toBeInTheDocument();
    unmount();

    renderPage('?team=none');
    expect(
      await screen.findByRole('link', { name: 'Hire' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Grow' })
    ).not.toBeInTheDocument();
  });

  it('groups by lead team with a No team group last', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', { team_id: 'team-2' }),
        initiative('ini-2', 'Hire'),
      ],
      next_cursor: null,
    });
    renderPage('?grouping=team');

    const growth = await screen.findByRole('region', { name: 'Growth' });
    expect(within(growth).getByText('Grow')).toBeInTheDocument();
    const none = screen.getByRole('region', { name: 'No team' });
    expect(within(none).getByText('Hire')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Platform' })
    ).not.toBeInTheDocument();
  });

  it('groups by owner, health and target month with the empty group last', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', {
          owner_id: 'user-1',
          health: 'at_risk',
          target_date: '2026-11-20',
        }),
        initiative('ini-2', 'Hire'),
      ],
      next_cursor: null,
    });
    const { unmount } = renderPage('?grouping=owner');
    const owned = await screen.findByRole('region', { name: 'Ada Lovelace' });
    expect(within(owned).getByText('Grow')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'No owner' })).getByText('Hire')
    ).toBeInTheDocument();
    unmount();

    const health = renderPage('?grouping=health');
    expect(
      within(await screen.findByRole('region', { name: 'At risk' })).getByText(
        'Grow'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'No health' })).toHaveTextContent(
      'Hire'
    );
    health.unmount();

    renderPage('?grouping=target_date');
    const november = await screen.findByRole('region', { name: 'Nov 2026' });
    expect(within(november).getByText('Grow')).toBeInTheDocument();
    const undated = screen.getByRole('region', { name: 'No target date' });
    expect(undated).toHaveTextContent('Hire');
    expect(
      november.compareDocumentPosition(undated) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('walks the rows with j and k, selects with x and opens with Enter', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [initiative('ini-1', 'Alpha'), initiative('ini-2', 'Beta')],
      next_cursor: null,
    });
    render(
      <MemoryRouter initialEntries={['/w/mine/initiatives?order=name']}>
        <ShortcutProvider>
          <BoundKeys />
          <Routes>
            <Route path="/w/:slug/initiatives" element={<Initiatives />} />
            <Route
              path="/w/:slug/initiatives/:id"
              element={<p>initiative page</p>}
            />
          </Routes>
        </ShortcutProvider>
      </MemoryRouter>
    );
    const press = (key: string): void => {
      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true })
        );
      });
    };
    const row = (name: string): HTMLElement | null =>
      screen.getByRole('link', { name }).closest('li');
    await screen.findByText('Beta');
    await keysBound('j', 'k');
    press('j');
    press('j');
    expect(row('Beta')).toHaveAttribute('aria-current', 'true');
    press('k');
    expect(row('Alpha')).toHaveAttribute('aria-current', 'true');
    await keysBound('x');
    press('x');
    expect(row('Alpha')).toHaveAttribute('aria-selected', 'true');
    await keysBound('enter');
    press('Enter');
    expect(await screen.findByText('initiative page')).toBeInTheDocument();
  });

  it('drags a row in the manual order and stores its place', async () => {
    const first = initiative('ini-1', 'Alpha', { sort_order: 'F' });
    const second = initiative('ini-2', 'Beta', { sort_order: 'V' });
    listInitiatives.mockResolvedValue({
      initiatives: [first, second],
      next_cursor: null,
    });
    updateInitiative.mockImplementation((id, body) =>
      Promise.resolve({
        ...(id === 'ini-1' ? first : second),
        ...body,
        updated_at: '2026-10-02T00:00:00Z',
      } as InitiativeRead)
    );
    renderPage('?order=manual');
    const alpha = (await screen.findByRole('link', { name: 'Alpha' })).closest(
      'li'
    );
    const list = alpha?.closest('ul');
    if (alpha === null || list === null || list === undefined)
      throw new Error('no row');
    const dataTransfer = {
      effectAllowed: '',
      dropEffect: '',
      setData: vi.fn(),
    };
    fireEvent.dragStart(alpha, { dataTransfer });
    fireEvent.dragOver(list, { dataTransfer });
    fireEvent.drop(list, { dataTransfer });

    await waitFor(() => {
      expect(updateInitiative).toHaveBeenCalledTimes(1);
    });
    const [id, body] = updateInitiative.mock.calls[0] ?? [];
    expect(id).toBe('ini-1');
    expect((body?.sort_order ?? '0') > 'V').toBe(true);
  });
});
