/**
 * The workspace sidebar: the teams it lists, the sub-links a team section
 * expands to, where the workspace switcher sends each role for settings, that
 * the section holding the current route opens without being clicked, each
 * team's options menu, the create controls each role is offered, and moving
 * a team by drag, keyboard or menu into the caller's saved order, and that a
 * team's triage entry survives a navigation that mounts a new sidebar while
 * the triage summary is being re-read, and that a team with cycles on offers
 * its current cycle under Cycles, and that each person's sidebar
 * customization shows, tucks into More or hides each item and draws dot badges,
 * and that the workspace menu lists the caller's workspaces and logs out.
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
import { invalidateQueries } from '@webbpulse/api-client/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SidebarDataProvider from '../../contexts/SidebarDataContext';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import {
  CreateTeamContext,
  type CreateTeamState,
} from '../../hooks/useCreateTeam';
import { CustomizeSidebarContext } from '../../hooks/useCustomizeSidebar';
import { triageSummaryKey } from '../../lib/queryKeys';
import type {
  CycleSettingsRead,
  FavoriteRead,
  ReviewsRead,
  SavedViewRead,
  TeamRead,
  TriageSummaryRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Sidebar from './Sidebar';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const setTeamOrder =
  vi.fn<(workspaceId: string, teamIds: string[]) => Promise<TeamRead[]>>();
const getInboxCount = vi.fn<() => Promise<{ count: number }>>();
const listViews = vi.fn<() => Promise<SavedViewRead[]>>();
const listFavorites = vi.fn<() => Promise<FavoriteRead[]>>();
const getTriageSummary = vi.fn<() => Promise<TriageSummaryRead>>();
const getReviews = vi.fn<() => Promise<ReviewsRead>>();
const getPulseCount = vi.fn<() => Promise<number>>();
const getCycleSettings =
  vi.fn<(teamId: string) => Promise<CycleSettingsRead>>();

const auth = vi.hoisted(() => {
  const user: Record<string, unknown> = {
    email: 'me@example.com',
    display_name: 'Me',
  };
  return {
    user,
    login: vi.fn<(user: Record<string, unknown>) => void>(),
    logout: vi.fn<() => Promise<void>>(),
  };
});
const updatePreferences =
  vi.fn<(changes: Record<string, unknown>) => Promise<unknown>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: auth.user,
    isLoading: false,
    isBusy: false,
    login: auth.login,
    logout: auth.logout,
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  setTeamOrder: (workspaceId: string, teamIds: string[]) =>
    setTeamOrder(workspaceId, teamIds),
  getCycleSettings: (_w: string, teamId: string) => getCycleSettings(teamId),
}));

vi.mock('../../api/views', () => ({
  getInboxCount: () => getInboxCount(),
  listViews: () => listViews(),
}));

vi.mock('../../api/favorites', () => ({
  listFavorites: () => listFavorites(),
  listFavoriteFolders: () => Promise.resolve([]),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));

vi.mock('../../api/triage', () => ({
  getTriageSummary: () => getTriageSummary(),
}));

vi.mock('../../api/reviews', () => ({
  getReviews: () => getReviews(),
}));

vi.mock('../../api/notifications', () => ({
  updatePreferences: (changes: Record<string, unknown>) =>
    updatePreferences(changes),
}));

vi.mock('../../api/pulse', () => ({
  getPulseCount: () => getPulseCount(),
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

/** One team row as the team list route answers it. */
const engine: TeamRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** A team's cycle schedule, switched on or off. */
const cycleSettings = (enabled: boolean): CycleSettingsRead => ({
  team_id: 'proj-1',
  enabled,
  duration_weeks: 2,
  cooldown_weeks: 0,
  start_weekday: 0,
  upcoming_count: 2,
  auto_add_started: true,
  move_unfinished: true,
  updated_at: null,
});

/** A second team, so the tests can tell one section from another. */
const design: TeamRead = {
  ...engine,
  id: 'proj-2',
  name: 'Design',
  key_prefix: 'DES',
};

/** The workspace the sidebar is rendered for, with the caller holding `role`. */
const workspace = (role: WorkspaceRole): WorkspaceRead => ({
  id: 'ws-1',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role,
});

/** The dialogs the workspace layout would provide around the sidebar. */
interface Dialogs {
  createIssue?: CreateIssueState;
  createTeam?: CreateTeamState;
}

/** Wraps a tree in whichever dialog contexts a test asked for. */
const withDialogs = (tree: ReactNode, dialogs: Dialogs): ReactNode => {
  let wrapped = tree;
  if (dialogs.createIssue !== undefined) {
    wrapped = (
      <CreateIssueContext.Provider value={dialogs.createIssue}>
        {wrapped}
      </CreateIssueContext.Provider>
    );
  }
  if (dialogs.createTeam !== undefined) {
    wrapped = (
      <CreateTeamContext.Provider value={dialogs.createTeam}>
        {wrapped}
      </CreateTeamContext.Provider>
    );
  }
  return wrapped;
};

/** Mounts the sidebar at `path`, which decides which section the route is in. */
const renderSidebar = (
  role: WorkspaceRole = 'owner',
  path = '/w/mine',
  dialogs: Dialogs = {}
) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      {withDialogs(
        <Routes>
          <Route
            path="/w/:slug"
            element={<Sidebar workspace={workspace(role)} />}
          />
          <Route
            path="/w/:slug/team/:keyPrefix"
            element={<Sidebar workspace={workspace(role)} />}
          />
          <Route
            path="/w/:slug/projects"
            element={<Sidebar workspace={workspace(role)} />}
          />
          <Route
            path="/w/:slug/issues/:key"
            element={<Sidebar workspace={workspace(role)} />}
          />
        </Routes>,
        dialogs
      )}
    </MemoryRouter>
  );

/** The section wrapping a team's toggle, its options menu and its links. */
const sectionOf = async (name: RegExp): Promise<HTMLElement> => {
  const team = await screen.findByRole('button', { name });
  const section = team.parentElement;
  if (section === null) throw new Error('the team section did not render');
  return section;
};

/** The team ids in the order the sidebar shows them. */
const shownOrder = (): string[] =>
  screen
    .getAllByTestId(/^team-section-/)
    .map(
      (row) =>
        row.getAttribute('data-testid')?.replace('team-section-', '') ?? ''
    );

/** A drag event body carrying the little of `DataTransfer` the sidebar uses. */
const dragData = (): { dataTransfer: Partial<DataTransfer> } => ({
  dataTransfer: { setData: vi.fn(), effectAllowed: 'all' },
});

beforeEach(() => {
  listTeams.mockReset();
  getCycleSettings.mockReset();
  getCycleSettings.mockResolvedValue(cycleSettings(false));
  setTeamOrder.mockReset();
  getInboxCount.mockReset();
  listTeams.mockResolvedValue([engine, design]);
  getInboxCount.mockResolvedValue({ count: 0 });
  listViews.mockReset();
  listViews.mockResolvedValue([]);
  listFavorites.mockReset();
  listFavorites.mockResolvedValue([]);
  getTriageSummary.mockReset();
  getTriageSummary.mockResolvedValue({ teams: [] });
  getReviews.mockReset();
  getReviews.mockResolvedValue({
    github_linked: true,
    counts: { needs_review: 0, changes_requested: 0, approved: 0 },
    items: [],
  });
  getPulseCount.mockReset();
  getPulseCount.mockResolvedValue(0);
  globalThis.localStorage.clear();
  auth.user = { email: 'me@example.com', display_name: 'Me' };
  auth.login.mockReset();
  auth.logout.mockReset();
  auth.logout.mockResolvedValue(undefined);
  updatePreferences.mockReset();
  updatePreferences.mockImplementation((changes) =>
    Promise.resolve({ ...auth.user, ...changes })
  );
});

describe('the workspace level links', () => {
  it('offers the places that span the whole workspace', async () => {
    renderSidebar();

    expect(await screen.findByRole('link', { name: /Inbox/ })).toHaveAttribute(
      'href',
      '/w/mine/inbox'
    );
    expect(screen.getByRole('link', { name: 'My issues' })).toHaveAttribute(
      'href',
      '/w/mine/issues'
    );
    expect(screen.getByRole('link', { name: 'Reviews' })).toHaveAttribute(
      'href',
      '/w/mine/reviews'
    );
    expect(screen.getByRole('link', { name: 'Pulse' })).toHaveAttribute(
      'href',
      '/w/mine/pulse'
    );
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/w/mine/projects'
    );
    expect(screen.getByRole('link', { name: 'Roadmap' })).toHaveAttribute(
      'href',
      '/w/mine/roadmap'
    );
  });
});

describe('the nav scroller', () => {
  it('is positioned so its hidden live region scrolls inside it instead of stretching the shell', async () => {
    renderSidebar();

    const nav = await screen.findByTestId('sidebar-nav');
    expect(nav).toHaveClass('relative', 'min-h-0', 'flex-1', 'overflow-y-auto');
  });
});

describe('the reviews badge', () => {
  it('counts the pull requests waiting on the caller', async () => {
    getReviews.mockResolvedValue({
      github_linked: true,
      counts: { needs_review: 3, changes_requested: 1, approved: 2 },
      items: [],
    });
    renderSidebar();

    expect(
      await screen.findByLabelText('3 waiting for your review')
    ).toBeInTheDocument();
  });
});

describe('the Pulse badge', () => {
  it('counts the unread Pulse entries', async () => {
    getPulseCount.mockResolvedValue(4);
    renderSidebar();

    expect(
      await screen.findByLabelText('4 unread in Pulse')
    ).toBeInTheDocument();
  });

  it('saturates at 99+', async () => {
    getPulseCount.mockResolvedValue(250);
    renderSidebar();

    expect(
      await screen.findByLabelText('99+ unread in Pulse')
    ).toBeInTheDocument();
  });
});

describe('the sign-out affordance', () => {
  it('carries the sign-out test id the account shell uses, so the e2e sign-out finds it from any signed-in page', async () => {
    renderSidebar();

    expect(await screen.findByTestId('sign-out')).toHaveAccessibleName(
      'Sign out'
    );
  });
});

describe('where the switcher sends each role for settings', () => {
  it('points a member at the settings they do have, which is their own keys', async () => {
    const user = userEvent.setup();
    renderSidebar('member');

    await user.click(await screen.findByRole('button', { name: /Mine/ }));

    expect(
      await screen.findByRole('menuitem', { name: 'Workspace settings' })
    ).toHaveAttribute('href', '/w/mine/settings/api-keys');
  });

  it('points an admin at the workspace settings page itself', async () => {
    const user = userEvent.setup();
    renderSidebar('admin');

    await user.click(await screen.findByRole('button', { name: /Mine/ }));

    expect(
      await screen.findByRole('menuitem', { name: 'Workspace settings' })
    ).toHaveAttribute('href', '/w/mine/settings');
  });
});

describe('the workspace menu', () => {
  /** Mounts the sidebar inside a workspace context holding `workspaces`. */
  const renderWithWorkspaces = (workspaces: WorkspaceRead[]) =>
    render(
      <WorkspaceContext.Provider
        value={{
          workspace: workspace('owner'),
          workspaces,
          isLoading: false,
          notFound: false,
          error: null,
          refresh: () => Promise.resolve(),
        }}
      >
        <MemoryRouter initialEntries={['/w/mine']}>
          <Routes>
            <Route
              path="/w/:slug"
              element={<Sidebar workspace={workspace('owner')} />}
            />
          </Routes>
        </MemoryRouter>
      </WorkspaceContext.Provider>
    );

  it('lists every workspace the caller belongs to, the current one checked, then All workspaces and Log out', async () => {
    const user = userEvent.setup();
    renderWithWorkspaces([
      workspace('owner'),
      { ...workspace('member'), id: 'ws-2', name: 'Acme', slug: 'acme' },
    ]);

    await user.click(await screen.findByRole('button', { name: /Mine/ }));

    expect(
      await screen.findByRole('menuitem', { name: /^Mine.*current/ })
    ).toHaveAttribute('href', '/w/mine');
    expect(screen.getByRole('menuitem', { name: 'Acme' })).toHaveAttribute(
      'href',
      '/w/acme'
    );
    const labels = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(labels.slice(-2)).toEqual(['All workspaces', 'Log out']);
  });

  it('shows the one workspace and Create workspace when the caller has only one', async () => {
    const user = userEvent.setup();
    renderWithWorkspaces([workspace('owner')]);

    await user.click(await screen.findByRole('button', { name: /Mine/ }));

    expect(
      await screen.findByRole('menuitem', { name: /^Mine.*current/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Create workspace' })
    ).toHaveAttribute('href', '/workspaces/new');
  });

  it('logs out from the menu', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: /Mine/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Log out' }));

    expect(auth.logout).toHaveBeenCalled();
  });
});

describe('the team sections', () => {
  it('lists every team the caller can see', async () => {
    renderSidebar();

    expect(
      await screen.findByRole('button', { name: /Engine/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Design/ })).toBeInTheDocument();
  });

  it('marks a private team it is a member of and leaves out one it only administers', async () => {
    listTeams.mockResolvedValue([
      { ...engine, private: true, is_member: true },
      { ...design, private: true, is_member: false },
    ]);
    renderSidebar();

    const team = await screen.findByRole('button', { name: /Engine/ });
    expect(within(team).getByLabelText('Private team')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Design/ })
    ).not.toBeInTheDocument();
  });

  it('keeps a team closed until it is asked to open', async () => {
    renderSidebar();

    const team = await screen.findByRole('button', { name: /Engine/ });
    expect(team).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('link', { name: 'Issues' })
    ).not.toBeInTheDocument();
  });

  it('expands to that team own surfaces when opened', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: /Engine/ }));

    expect(screen.getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG'
    );
    expect(screen.getByRole('link', { name: 'Cycles' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/cycles'
    );
  });

  it('offers the current cycle under Cycles when the team has cycles on', async () => {
    getCycleSettings.mockResolvedValue(cycleSettings(true));
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: /Engine/ }));

    expect(
      await screen.findByRole('link', { name: 'Current cycle' })
    ).toHaveAttribute('href', '/w/mine/team/ENG/cycles/current');
    expect(getCycleSettings).toHaveBeenCalledWith('proj-1');
    expect(getCycleSettings).not.toHaveBeenCalledWith('proj-2');
  });

  it('leaves the current cycle out when the team has cycles off', async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole('button', { name: /Engine/ }));

    await waitFor(() => {
      expect(getCycleSettings).toHaveBeenCalledWith('proj-1');
    });
    expect(screen.getByRole('link', { name: 'Cycles' })).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Current cycle' })
    ).not.toBeInTheDocument();
  });

  it('opens the section the current route is inside without being clicked', async () => {
    renderSidebar('owner', '/w/mine/team/DES');

    const team = await screen.findByRole('button', { name: /Design/ });
    await waitFor(() => {
      expect(team).toHaveAttribute('aria-expanded', 'true');
    });
    expect(screen.getByRole('button', { name: /Engine/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('reads the team out of an issue key, so a detail page opens its section', async () => {
    renderSidebar('owner', '/w/mine/issues/ENG-12');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Engine/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
  });

  it('remembers the sections left open, per workspace', async () => {
    const user = userEvent.setup();
    const view = renderSidebar();

    await user.click(await screen.findByRole('button', { name: /Engine/ }));
    view.unmount();

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Engine/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
  });

  it('points a team projects link at that team slice of the projects list', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const team = await screen.findByRole('button', { name: /Engine/ });
    await user.click(team);

    const section = team.parentElement;
    if (section === null) throw new Error('the team section did not render');
    expect(
      within(section).getByRole('link', { name: 'Projects' })
    ).toHaveAttribute('href', '/w/mine/projects?team=ENG');
  });

  it('ends a team section with a Views link to the views shared with that team', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const team = await screen.findByRole('button', { name: /Engine/ });
    await user.click(team);

    const section = team.parentElement;
    if (section === null) throw new Error('the team section did not render');
    const links = within(section).getAllByRole('link');
    expect(links[links.length - 1]).toHaveAccessibleName('Views');
    expect(links[links.length - 1]).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/views'
    );
  });

  it('marks only the team whose projects slice is open as current', async () => {
    listTeams.mockResolvedValue([engine, design]);
    renderSidebar('owner', '/w/mine/projects?team=ENG');

    const team = await screen.findByRole('button', { name: /Engine/ });
    await waitFor(() => {
      expect(team).toHaveAttribute('aria-expanded', 'true');
    });
    const section = team.parentElement;
    if (section === null) throw new Error('the team section did not render');
    expect(
      within(section).getByRole('link', { name: 'Projects' })
    ).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /Design/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});

describe('the team options menu', () => {
  it('links to the team settings and copies the team link', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderSidebar();

    const section = await sectionOf(/Engine/);
    await user.click(
      within(section).getByRole('button', { name: 'Team options' })
    );

    expect(
      await screen.findByRole('menuitem', { name: 'Team settings' })
    ).toHaveAttribute('href', '/w/mine/team/ENG/settings');

    await user.click(screen.getByRole('menuitem', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(
      `${globalThis.location.origin}/w/mine/team/ENG`
    );
  });

  it('offers no leave, because the API has no route for it', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const section = await sectionOf(/Engine/);
    await user.click(
      within(section).getByRole('button', { name: 'Team options' })
    );

    await screen.findByRole('menuitem', { name: 'Team settings' });
    expect(
      screen.queryByRole('menuitem', { name: /Leave/ })
    ).not.toBeInTheDocument();
  });
});

describe('creating from the sidebar', () => {
  it('opens the create team dialog from the teams header and from Add team', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    renderSidebar('member', '/w/mine', {
      createTeam: { open, openSubTeam: vi.fn(), canCreate: true },
    });

    await screen.findByRole('button', { name: /Engine/ });
    await user.click(screen.getByRole('button', { name: 'Create team' }));
    await user.click(screen.getByRole('button', { name: 'Add team' }));

    expect(open).toHaveBeenCalledTimes(2);
  });

  it('keeps Add team visible when the workspace has no teams', async () => {
    listTeams.mockResolvedValue([]);
    renderSidebar('owner', '/w/mine', {
      createTeam: { open: vi.fn(), openSubTeam: vi.fn(), canCreate: true },
    });

    expect(
      await screen.findByRole('button', { name: 'Add team' })
    ).toBeInTheDocument();
  });

  it('hides the create team controls from a role that cannot create', async () => {
    listTeams.mockResolvedValue([]);
    renderSidebar('guest', '/w/mine', {
      createTeam: { open: vi.fn(), openSubTeam: vi.fn(), canCreate: false },
    });

    expect(await screen.findByText('No teams yet.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add team' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Create team' })
    ).not.toBeInTheDocument();
  });

  it('opens the create issue dialog from the header', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    renderSidebar('owner', '/w/mine', {
      createIssue: {
        open,
        close: vi.fn(),
        isOpen: false,
        canCreate: true,
        request: null,
      },
    });

    await user.click(
      await screen.findByRole('button', { name: 'Create issue' })
    );

    expect(open).toHaveBeenCalled();
    expect(screen.queryByTestId('issue-draft-dot')).not.toBeInTheDocument();
  });

  it('marks the create issue button while a draft is saved', async () => {
    renderSidebar('owner', '/w/mine', {
      createIssue: {
        open: vi.fn(),
        close: vi.fn(),
        isOpen: false,
        canCreate: true,
        request: null,
        hasDraft: true,
      },
    });

    expect(
      await screen.findByRole('button', { name: 'Create issue, draft saved' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('issue-draft-dot')).toBeInTheDocument();
  });

  it('lists the caller favorites in their own order with links to each', async () => {
    listFavorites.mockResolvedValue([
      { kind: 'view', target_id: 'view-1', title: 'My bugs' },
      {
        kind: 'issue',
        target_id: 'issue-1',
        title: 'Fix the login',
        issue_key: 'ENG-7',
        team_id: 'team-1',
        team_key_prefix: 'ENG',
      },
      { kind: 'cycle', target_id: 'cycle-1', title: 'Lost its team' },
    ]);
    renderSidebar();

    const section = await screen.findByTestId('sidebar-favorites');
    const links = within(section).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/w/mine/views/view-1',
      '/w/mine/issues/ENG-7',
    ]);
    expect(
      screen.queryByRole('link', { name: /Lost its team/ })
    ).not.toBeInTheDocument();
  });

  it('leaves the Favorites section out while nothing is starred', async () => {
    renderSidebar();

    await screen.findByRole('link', { name: /Inbox/ });
    expect(screen.queryByTestId('sidebar-favorites')).not.toBeInTheDocument();
  });
});

describe('reordering teams', () => {
  it('moves a dragged team to where it is dropped, with a drop line first', async () => {
    setTeamOrder.mockImplementation(() => {
      listTeams.mockResolvedValue([design, engine]);
      return Promise.resolve([design, engine]);
    });
    renderSidebar();
    await screen.findByRole('button', { name: /Design/ });
    const dragged = screen.getByTestId('team-section-proj-2');
    const target = screen.getByTestId('team-section-proj-1');

    fireEvent.dragStart(dragged, dragData());
    fireEvent.dragEnter(target, dragData());
    const line = within(target).getByTestId('team-drop-indicator');
    expect(line).toHaveClass('-top-px');

    fireEvent.drop(target, dragData());
    fireEvent.dragEnd(dragged, dragData());

    expect(shownOrder()).toEqual(['proj-2', 'proj-1']);
    expect(setTeamOrder).toHaveBeenCalledWith('ws-1', ['proj-2', 'proj-1']);
    expect(screen.queryByTestId('team-drop-indicator')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(listTeams).toHaveBeenCalledTimes(2);
    });
    expect(shownOrder()).toEqual(['proj-2', 'proj-1']);
  });

  it('moves a team with Alt and an arrow key and announces it', async () => {
    const user = userEvent.setup();
    setTeamOrder.mockImplementation(() => {
      listTeams.mockResolvedValue([design, engine]);
      return Promise.resolve([design, engine]);
    });
    renderSidebar();
    const toggle = await screen.findByRole('button', { name: /Engine/ });

    toggle.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(shownOrder()).toEqual(['proj-2', 'proj-1']);
    expect(setTeamOrder).toHaveBeenCalledWith('ws-1', ['proj-2', 'proj-1']);
    expect(
      screen.getByText('Moved Engine to position 2 of 2.')
    ).toBeInTheDocument();
  });

  it('ignores an arrow key without Alt and a move past the end', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const toggle = await screen.findByRole('button', { name: /Design/ });

    toggle.focus();
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(setTeamOrder).not.toHaveBeenCalled();
    expect(shownOrder()).toEqual(['proj-1', 'proj-2']);
  });

  it('moves a team from its options menu', async () => {
    const user = userEvent.setup();
    setTeamOrder.mockResolvedValue([design, engine]);
    renderSidebar();
    const section = await sectionOf(/Design/);

    await user.click(
      within(section).getByRole('button', { name: 'Team options' })
    );
    expect(
      screen.queryByRole('menuitem', { name: 'Move down' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));

    expect(setTeamOrder).toHaveBeenCalledWith('ws-1', ['proj-2', 'proj-1']);
  });

  it('puts the saved order back when the save fails', async () => {
    const user = userEvent.setup();
    setTeamOrder.mockRejectedValue(new Error('offline'));
    renderSidebar();
    const toggle = await screen.findByRole('button', { name: /Engine/ });

    toggle.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    await waitFor(() => {
      expect(shownOrder()).toEqual(['proj-1', 'proj-2']);
    });
    expect(
      screen.getByText('The team order could not be saved.')
    ).toBeInTheDocument();
  });

  it('offers no moves while there is a single team', async () => {
    listTeams.mockResolvedValue([engine]);
    renderSidebar();

    const section = await screen.findByTestId('team-section-proj-1');
    expect(section).toHaveAttribute('draggable', 'false');
  });
});

describe('sub-teams', () => {
  /** A sub-team of Engine. */
  const web: TeamRead = {
    ...engine,
    id: 'proj-3',
    name: 'Web',
    key_prefix: 'WEB',
    parent_team_id: 'proj-1',
  };

  beforeEach(() => {
    listTeams.mockResolvedValue([engine, design, web]);
  });

  it('keeps a sub-team folded under its parent until the parent opens', async () => {
    const user = userEvent.setup();
    renderSidebar();
    const toggle = await screen.findByRole('button', { name: /Engine/ });
    expect(shownOrder()).toEqual(['proj-1', 'proj-2']);

    await user.click(toggle);

    expect(shownOrder()).toEqual(['proj-1', 'proj-3', 'proj-2']);
  });

  it('expands the collapsed parent of the sub-team the route is in', async () => {
    const user = userEvent.setup();
    renderSidebar('owner', '/w/mine/team/WEB');
    await screen.findByRole('button', { name: /Web/ });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Engine/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
    });
    expect(shownOrder()).toEqual(['proj-1', 'proj-3', 'proj-2']);
    expect(
      globalThis.localStorage.getItem('standupless.sidebar.teams.ws-1')
    ).toBe(JSON.stringify(['ENG']));

    await user.click(screen.getByRole('button', { name: /Engine/ }));

    expect(shownOrder()).toEqual(['proj-1', 'proj-2']);
  });

  it('moves a parent past the next team with its sub-team along', async () => {
    const user = userEvent.setup();
    setTeamOrder.mockResolvedValue([web, design, engine]);
    renderSidebar();
    const toggle = await screen.findByRole('button', { name: /Engine/ });

    toggle.focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

    expect(setTeamOrder).toHaveBeenCalledWith('ws-1', [
      'proj-3',
      'proj-2',
      'proj-1',
    ]);
  });

  it('offers a sub-team no move out from under its parent', async () => {
    const user = userEvent.setup();
    renderSidebar('owner', '/w/mine/team/WEB');
    const section = await sectionOf(/Web/);

    await user.click(
      within(section).getByRole('button', { name: 'Team options' })
    );

    expect(
      screen.queryByRole('menuitem', { name: 'Move up' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Move down' })
    ).not.toBeInTheDocument();
  });

  it('creates a sub-team from a top-level team menu with that team as parent', async () => {
    const user = userEvent.setup();
    const openSubTeam = vi.fn();
    renderSidebar('owner', '/w/mine/team/WEB', {
      createTeam: { open: vi.fn(), openSubTeam, canCreate: true },
    });
    const section = await sectionOf(/Engine/);

    await user.click(
      within(section).getByRole('button', { name: 'Team options' })
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Create sub-team' })
    );

    expect(openSubTeam).toHaveBeenCalledWith('proj-1');
  });

  it('offers no sub-team of a sub-team', async () => {
    const user = userEvent.setup();
    renderSidebar('owner', '/w/mine/team/WEB', {
      createTeam: { open: vi.fn(), openSubTeam: vi.fn(), canCreate: true },
    });
    const sub = await sectionOf(/Web/);

    await user.click(within(sub).getByRole('button', { name: 'Team options' }));
    await screen.findByRole('menuitem', { name: 'Team settings' });

    expect(
      screen.queryByRole('menuitem', { name: 'Create sub-team' })
    ).not.toBeInTheDocument();
  });

  it('hides Create sub-team when the caller cannot create teams', async () => {
    const user = userEvent.setup();
    renderSidebar('guest', '/w/mine', {
      createTeam: { open: vi.fn(), openSubTeam: vi.fn(), canCreate: false },
    });
    const section = await sectionOf(/Engine/);

    await user.click(
      within(section).getByRole('button', { name: 'Team options' })
    );
    await screen.findByRole('menuitem', { name: 'Team settings' });

    expect(
      screen.queryByRole('menuitem', { name: 'Create sub-team' })
    ).not.toBeInTheDocument();
  });
});

describe('the triage entry across navigation', () => {
  /**
   * Mounts the sidebar the way the app does: the workspace layout holds the
   * shared reads, and each page renders a sidebar of its own, which the keys
   * here force to mount afresh on every navigation.
   */
  const renderPages = () =>
    render(
      <WorkspaceContext.Provider
        value={{
          workspace: workspace('owner'),
          isLoading: false,
          notFound: false,
          error: null,
          refresh: () => Promise.resolve(),
        }}
      >
        <MemoryRouter initialEntries={['/w/mine/team/ENG']}>
          <Routes>
            <Route
              element={
                <SidebarDataProvider>
                  <Outlet />
                </SidebarDataProvider>
              }
            >
              <Route
                path="/w/:slug/team/:keyPrefix"
                element={
                  <Sidebar key="issues" workspace={workspace('owner')} />
                }
              />
              <Route
                path="/w/:slug/team/:keyPrefix/triage"
                element={
                  <Sidebar key="triage" workspace={workspace('owner')} />
                }
              />
            </Route>
          </Routes>
        </MemoryRouter>
      </WorkspaceContext.Provider>
    );

  it('keeps the last known triage entry while a re-read is in flight, and drops it only once triage is off', async () => {
    getTriageSummary.mockResolvedValueOnce({
      teams: [{ team_id: 'proj-1', count: 2 }],
    });
    renderPages();
    const user = userEvent.setup();

    const triage = await screen.findByRole('link', { name: /^Triage/ });
    expect(within(triage).getByLabelText('2 waiting')).toBeInTheDocument();

    let settle: (value: TriageSummaryRead) => void = () => undefined;
    getTriageSummary.mockReturnValueOnce(
      new Promise<TriageSummaryRead>((resolve) => {
        settle = resolve;
      })
    );
    act(() => {
      invalidateQueries(triageSummaryKey('ws-1'));
    });
    await user.click(triage);

    const after = screen.getByRole('link', { name: /^Triage/ });
    expect(after).toHaveAttribute('aria-current', 'page');
    expect(within(after).getByLabelText('2 waiting')).toBeInTheDocument();

    await act(async () => {
      settle({ teams: [] });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('link', { name: /^Triage/ })
      ).not.toBeInTheDocument();
    });
  });
});

describe('the sidebar customization', () => {
  it('shows every item while nothing has been moved', async () => {
    renderSidebar();

    expect(
      await screen.findByRole('link', { name: 'Views' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-more')).not.toBeInTheDocument();
  });

  it('tucks an item moved to More into the More menu', async () => {
    const user = userEvent.setup();
    auth.user = { ...auth.user, sidebar_items: { roadmap: 'more' } };
    renderSidebar();

    await screen.findByRole('link', { name: 'Projects' });
    expect(
      screen.queryByRole('link', { name: 'Roadmap' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('sidebar-more'));
    expect(
      await screen.findByRole('menuitem', { name: 'Roadmap' })
    ).toBeInTheDocument();
  });

  it('leaves a hidden item out of the sidebar and the More menu', async () => {
    const user = userEvent.setup();
    auth.user = {
      ...auth.user,
      sidebar_items: { roadmap: 'hide', views: 'more' },
    };
    renderSidebar();

    await screen.findByRole('link', { name: 'Projects' });
    expect(
      screen.queryByRole('link', { name: 'Roadmap' })
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('sidebar-more'));
    await screen.findByRole('menuitem', { name: 'Views' });
    expect(
      screen.queryByRole('menuitem', { name: 'Roadmap' })
    ).not.toBeInTheDocument();
  });

  it('draws a dot in place of the count when the dot style is chosen', async () => {
    auth.user = { ...auth.user, sidebar_badge_style: 'dot' };
    getPulseCount.mockResolvedValue(4);
    renderSidebar();

    expect(await screen.findByLabelText('4 unread in Pulse')).toHaveAttribute(
      'data-testid',
      'sidebar-badge-dot'
    );
    expect(screen.queryByText('4')).not.toBeInTheDocument();
  });

  it('hides an item from its right-click menu and saves it', async () => {
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(await screen.findByRole('link', { name: 'Views' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide' }));

    expect(updatePreferences).toHaveBeenCalledWith({
      sidebar_items: { views: 'hide' },
    });
    expect(auth.login.mock.calls[0]?.[0]['sidebar_items']).toMatchObject({
      views: 'hide',
    });
  });

  it('moves an item to More from its right-click menu', async () => {
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(await screen.findByRole('link', { name: 'Roadmap' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Move to More' })
    );

    expect(updatePreferences).toHaveBeenCalledWith({
      sidebar_items: { roadmap: 'more' },
    });
  });
});

describe('opening Customize sidebar', () => {
  it('opens from an item right-click menu', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <CustomizeSidebarContext.Provider value={{ open }}>
        <MemoryRouter initialEntries={['/w/mine']}>
          <Routes>
            <Route
              path="/w/:slug"
              element={<Sidebar workspace={workspace('owner')} />}
            />
          </Routes>
        </MemoryRouter>
      </CustomizeSidebarContext.Provider>
    );

    fireEvent.contextMenu(await screen.findByRole('link', { name: 'Pulse' }));
    await user.click(
      await screen.findByRole('menuitem', { name: 'Customize sidebar' })
    );

    expect(open).toHaveBeenCalled();
  });
});
