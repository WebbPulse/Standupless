/**
 * The workspace settings Teams page: every visible team with its key and the
 * caller's role, each row's way into that team's settings, and a Create team
 * button offered only to the roles the create route accepts.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import {
  CreateTeamContext,
  type CreateTeamState,
} from '../../hooks/useCreateTeam';
import type { TeamRead, WorkspaceRead, WorkspaceRole } from '../../types/Api';
import TeamsSettings from './TeamsSettings';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
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

/** A team the caller administers. */
const engine: TeamRead = {
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

/** A team the caller is an ordinary member of. */
const design: TeamRead = {
  ...engine,
  id: 'team-2',
  name: 'Design',
  key_prefix: 'DES',
  role: 'member',
};

/** A resolved workspace context with the caller holding `role`. */
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

/** Renders the page inside the create team context the layout provides. */
const renderPage = (createTeam: CreateTeamState) =>
  render(
    <MemoryRouter initialEntries={['/w/mine/settings/teams']}>
      <CreateTeamContext.Provider value={createTeam}>
        <TeamsSettings />
      </CreateTeamContext.Provider>
    </MemoryRouter>
  );

beforeEach(() => {
  listTeams.mockReset();
  listTeams.mockResolvedValue([engine, design]);
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
});

describe('the team list', () => {
  it('shows each team with its key and the caller role', async () => {
    renderPage({ open: vi.fn(), canCreate: true });

    const row = (await screen.findByRole('link', { name: /Engine/ })).closest(
      'tr'
    );
    if (row === null) throw new Error('the team row did not render');
    expect(within(row).getByText('ENG')).toBeInTheDocument();
    expect(within(row).getByText('Admin')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Engine/ })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/settings'
    );
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('opens a row menu with the team settings and no leave action', async () => {
    const user = userEvent.setup();
    renderPage({ open: vi.fn(), canCreate: true });

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Engine' })
    );

    expect(
      await screen.findByRole('menuitem', { name: 'Team settings' })
    ).toHaveAttribute('href', '/w/mine/team/ENG/settings');
    expect(
      screen.queryByRole('menuitem', { name: /Leave/ })
    ).not.toBeInTheDocument();
  });

  it('links to the page from the settings tabs', async () => {
    renderPage({ open: vi.fn(), canCreate: true });

    expect(await screen.findByRole('link', { name: 'Teams' })).toHaveAttribute(
      'href',
      '/w/mine/settings/teams'
    );
  });
});

describe('creating a team', () => {
  it('opens the create team dialog from the page', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    renderPage({ open, canCreate: true });

    await screen.findByRole('link', { name: /Engine/ });
    await user.click(
      within(screen.getByRole('main')).getByRole('button', {
        name: 'Create team',
      })
    );

    expect(open).toHaveBeenCalled();
  });

  it('hides Create team from a role the create route refuses', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    renderPage({ open: vi.fn(), canCreate: false });

    await screen.findByRole('link', { name: /Engine/ });

    expect(
      within(screen.getByRole('main')).queryByRole('button', {
        name: 'Create team',
      })
    ).not.toBeInTheDocument();
  });

  it('offers Create team from the empty state when there are no teams', async () => {
    listTeams.mockResolvedValue([]);
    renderPage({ open: vi.fn(), canCreate: true });

    expect(
      await screen.findByText(
        'No teams yet. Create one to start filing issues.'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).getAllByRole('button', {
        name: 'Create team',
      })
    ).toHaveLength(2);
  });
});
