/**
 * The workspace sidebar: the teams it lists, the sub-links a team section
 * expands to, where the workspace switcher sends each role for settings, that
 * the section holding the current route opens without being clicked, each
 * team's options menu, and the create controls each role is offered.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import {
  CreateTeamContext,
  type CreateTeamState,
} from '../../hooks/useCreateTeam';
import type {
  SavedViewRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Sidebar from './Sidebar';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const getInboxCount = vi.fn<() => Promise<{ count: number }>>();
const listViews = vi.fn<() => Promise<SavedViewRead[]>>();

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
}));

vi.mock('../../api/views', () => ({
  getInboxCount: () => getInboxCount(),
  listViews: () => listViews(),
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

beforeEach(() => {
  listTeams.mockReset();
  getInboxCount.mockReset();
  listTeams.mockResolvedValue([engine, design]);
  getInboxCount.mockResolvedValue({ count: 0 });
  listViews.mockReset();
  listViews.mockResolvedValue([]);
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
      createTeam: { open, canCreate: true },
    });

    await screen.findByRole('button', { name: /Engine/ });
    await user.click(screen.getByRole('button', { name: 'Create team' }));
    await user.click(screen.getByRole('button', { name: 'Add team' }));

    expect(open).toHaveBeenCalledTimes(2);
  });

  it('keeps Add team visible when the workspace has no teams', async () => {
    listTeams.mockResolvedValue([]);
    renderSidebar('owner', '/w/mine', {
      createTeam: { open: vi.fn(), canCreate: true },
    });

    expect(
      await screen.findByRole('button', { name: 'Add team' })
    ).toBeInTheDocument();
  });

  it('hides the create team controls from a role that cannot create', async () => {
    listTeams.mockResolvedValue([]);
    renderSidebar('guest', '/w/mine', {
      createTeam: { open: vi.fn(), canCreate: false },
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

  it('lists the caller own saved views', async () => {
    listViews.mockResolvedValue([
      {
        view_id: 'view-1',
        workspace_id: 'ws-1',
        name: 'My bugs',
      } as SavedViewRead,
    ]);
    renderSidebar();

    expect(
      await screen.findByRole('link', { name: /My bugs/ })
    ).toHaveAttribute('href', '/w/mine/views/view-1');
  });
});
