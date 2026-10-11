/**
 * The workspace sidebar: the teams it lists, the sub-links a team section
 * expands to, where the workspace switcher sends each role for settings, that
 * the section holding the current route opens without being clicked, each
 * team's options menu, the create controls each role is offered, and moving
 * a team by drag, keyboard or menu into the caller's saved order, and that a
 * team's triage entry survives a navigation that mounts a new sidebar while
 * the triage summary is being re-read.
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
import { triageSummaryKey } from '../../lib/queryKeys';
import type {
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
const getTriageSummary = vi.fn<() => Promise<TriageSummaryRead>>();
const getReviews = vi.fn<() => Promise<ReviewsRead>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { email: 'me@example.com', display_name: 'Me' },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  setTeamOrder: (workspaceId: string, teamIds: string[]) =>
    setTeamOrder(workspaceId, teamIds),
}));

vi.mock('../../api/views', () => ({
  getInboxCount: () => getInboxCount(),
  listViews: () => listViews(),
}));

vi.mock('../../api/triage', () => ({
  getTriageSummary: () => getTriageSummary(),
}));

vi.mock('../../api/reviews', () => ({
  getReviews: () => getReviews(),
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
  setTeamOrder.mockReset();
  getInboxCount.mockReset();
  listTeams.mockResolvedValue([engine, design]);
  getInboxCount.mockResolvedValue({ count: 0 });
  listViews.mockReset();
  listViews.mockResolvedValue([]);
  getTriageSummary.mockReset();
  getTriageSummary.mockResolvedValue({ teams: [] });
  getReviews.mockReset();
  getReviews.mockResolvedValue({
    github_linked: true,
    counts: { needs_review: 0, changes_requested: 0, approved: 0 },
    items: [],
  });
  globalThis.localStorage.clear();
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
  });

  it('lists the caller favorite views and leaves the rest out', async () => {
    listViews.mockResolvedValue([
      {
        view_id: 'view-1',
        workspace_id: 'ws-1',
        name: 'My bugs',
        favorite: true,
      } as unknown as SavedViewRead,
      {
        view_id: 'view-2',
        workspace_id: 'ws-1',
        name: 'Not starred',
        favorite: false,
      } as unknown as SavedViewRead,
    ]);
    renderSidebar();

    expect(
      await screen.findByRole('link', { name: /My bugs/ })
    ).toHaveAttribute('href', '/w/mine/views/view-1');
    expect(
      screen.queryByRole('link', { name: /Not starred/ })
    ).not.toBeInTheDocument();
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

  it('shows the sub-team the route is in with its parent closed', async () => {
    renderSidebar('owner', '/w/mine/team/WEB');
    await screen.findByRole('button', { name: /Web/ });

    expect(shownOrder()).toEqual(['proj-1', 'proj-3', 'proj-2']);
    expect(screen.getByRole('button', { name: /Engine/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
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
