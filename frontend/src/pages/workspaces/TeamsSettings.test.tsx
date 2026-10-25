/**
 * The workspace settings Teams page: every visible team with its key and the
 * caller's role, each row's way into that team's settings, and a Create team
 * button offered only to the roles the create route accepts, and the retired
 * teams listed apart with an un-retire action.
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
const unretireTeam = vi.fn<() => Promise<TeamRead>>();
const downloadText = vi.fn<(text: string, name: string) => void>();

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
  unretireTeam: () => unretireTeam(),
}));

vi.mock('../../lib/download', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/download')>(
      '../../lib/download'
    );
  return {
    ...actual,
    downloadText: (text: string, name: string) => downloadText(text, name),
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
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: true });

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
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: true });

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
});

describe('creating a team', () => {
  it('opens the create team dialog from the page', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    renderPage({ open, openSubTeam: vi.fn(), canCreate: true });

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
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: false });

    await screen.findByRole('link', { name: /Engine/ });

    expect(
      within(screen.getByRole('main')).queryByRole('button', {
        name: 'Create team',
      })
    ).not.toBeInTheDocument();
  });

  it('tells a member why Create team is missing when only admins may create teams', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: false });

    await screen.findByRole('link', { name: /Engine/ });

    expect(
      screen.getByText(
        'Only workspace admins can create teams in this workspace.'
      )
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).queryByRole('button', {
        name: 'Create team',
      })
    ).not.toBeInTheDocument();
  });

  it('offers Create team from the empty state when there are no teams', async () => {
    listTeams.mockResolvedValue([]);
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: true });

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

describe('retired teams', () => {
  it('lists a retired team apart and un-retires it', async () => {
    const retired = { ...engine, retired_at: '2026-10-20T00:00:00Z' };
    listTeams.mockResolvedValue([retired, design]);
    unretireTeam.mockResolvedValue(engine);
    const user = userEvent.setup();
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: true });

    const section = (
      await screen.findByRole('heading', { name: 'Retired teams' })
    ).closest('section');
    if (section === null) throw new Error('the retired section did not render');
    expect(
      within(screen.getByRole('table')).queryByText('Engine')
    ).not.toBeInTheDocument();

    await user.click(
      within(section).getByRole('button', { name: 'Un-retire Engine' })
    );

    expect(unretireTeam).toHaveBeenCalled();
  });

  it('offers un-retire only to an admin of the team', async () => {
    listTeams.mockResolvedValue([
      engine,
      { ...design, retired_at: '2026-10-20T00:00:00Z' },
    ]);
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: true });

    expect(
      await screen.findByRole('heading', { name: 'Retired teams' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Un-retire Design' })
    ).not.toBeInTheDocument();
  });
});

describe('exporting the teams', () => {
  it('downloads every team as CSV, retired ones included', async () => {
    const user = userEvent.setup();
    downloadText.mockReset();
    listTeams.mockResolvedValue([
      engine,
      {
        ...design,
        parent_team_id: 'team-1',
        private: true,
        retired_at: '2026-10-01T00:00:00Z',
      },
    ]);
    renderPage({ open: vi.fn(), openSubTeam: vi.fn(), canCreate: true });

    await screen.findByRole('link', { name: /Engine/ });
    await user.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(downloadText).toHaveBeenCalledTimes(1);
    const [text, name] = downloadText.mock.calls[0] ?? ['', ''];
    expect(name).toMatch(/^mine-teams-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(text.split('\r\n')).toEqual([
      'Name,Key,Parent team key,Visibility,Members,Created,Retired',
      'Engine,ENG,,Public,,2026-09-17,',
      'Design,DES,ENG,Private,,2026-09-17,2026-10-01',
      '',
    ]);
  });
});
