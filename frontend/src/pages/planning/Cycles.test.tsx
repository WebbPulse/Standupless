/**
 * The cycles page. Covers that the list is read under the team the route
 * names, that the running cycle leads the page while the rest group into
 * upcoming and past, that creating sends no status because the server derives
 * it, that the controls a role may not use are not drawn, and that velocity
 * and capacity guidance read under the current cycle. A parent team's list
 * rolls up its sub-teams' cycles on the same dates until the toggle narrows
 * it to the team alone.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CycleCreate,
  CycleListRead,
  CycleRead,
  TeamRead,
  VelocityRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Cycles from './Cycles';

const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();
const createCycle = vi.fn<(body: CycleCreate) => Promise<CycleRead>>();
const updateCycle = vi.fn<(id: string, body: unknown) => Promise<CycleRead>>();
const deleteCycle = vi.fn<(id: string) => Promise<void>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const getVelocity = vi.fn<(teamId: string) => Promise<VelocityRead>>();

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

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: unknown) => listCycles(query),
  createCycle: (_w: string, body: CycleCreate) => createCycle(body),
  updateCycle: (_w: string, id: string, body: unknown) => updateCycle(id, body),
  deleteCycle: (_w: string, id: string) => deleteCycle(id),
  getVelocity: (_w: string, teamId: string) => getVelocity(teamId),
}));

/** Two closed cycles and the running one to plan against. */
const velocity: VelocityRead = {
  team_id: 'proj-1',
  estimate_scale: 'off',
  cycles: [
    {
      cycle_id: 'old-1',
      name: 'Sprint A',
      start_date: '2026-08-01',
      end_date: '2026-08-14',
      completed_issues: 4,
      completed_points: 8,
      scope_issues: 6,
      scope_points: 12,
      carried_out: 2,
      carried_out_points: 4,
    },
    {
      cycle_id: 'old-2',
      name: 'Sprint B',
      start_date: '2026-08-15',
      end_date: '2026-08-28',
      completed_issues: 6,
      completed_points: 12,
      scope_issues: 6,
      scope_points: 12,
      carried_out: 0,
      carried_out_points: 0,
    },
  ],
  average_points: 10,
  average_issues: 5,
  upcoming: {
    cycle_id: 'cyc-1',
    name: 'Sprint 1',
    status: 'active',
    start_date: '2026-09-01',
    end_date: '2026-09-14',
    scope_issues: 7,
    scope_points: 9,
    carried_in: 2,
    carried_in_points: 4,
  },
};

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

const team: TeamRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const cycle: CycleRead = {
  cycle_id: 'cyc-1',
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  name: 'Sprint 1',
  start_date: '2026-09-01',
  end_date: '2026-09-14',
  goal: 'Ship the engine',
  cancelled: false,
  status: 'active',
  counts: { todo: 1, in_progress: 1, done: 2, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** A cycle that has not started, which is the shape the dense rows draw. */
const upcoming: CycleRead = {
  ...cycle,
  cycle_id: 'cyc-2',
  name: 'Sprint 2',
  start_date: '2026-09-15',
  end_date: '2026-09-28',
  status: 'upcoming',
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

const renderPage = (entry = '/w/mine/team/ENG/cycles') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/team/:keyPrefix/cycles" element={<Cycles />} />
      </Routes>
    </MemoryRouter>
  );

/** Opens the create dialog, which the page no longer keeps open on the page. */
const openCreate = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'New cycle' }));
  return screen.findByRole('dialog');
};

beforeEach(() => {
  listCycles.mockReset();
  createCycle.mockReset();
  updateCycle.mockReset();
  deleteCycle.mockReset();
  listTeams.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  listTeams.mockResolvedValue([team]);
  listCycles.mockResolvedValue({ cycles: [cycle], next_cursor: null });
  createCycle.mockResolvedValue(cycle);
  updateCycle.mockResolvedValue(cycle);
  deleteCycle.mockResolvedValue(undefined);
  getVelocity.mockReset();
  getVelocity.mockResolvedValue(velocity);
});

describe('velocity', () => {
  it('charts the closed cycles with their average', async () => {
    renderPage();

    const panel = await screen.findByRole('region', { name: 'Velocity' });
    expect(getVelocity).toHaveBeenCalledWith('proj-1');
    expect(
      within(panel).getByText('Average 5 issues over the last 2 cycles')
    ).toBeInTheDocument();
    expect(within(panel).getAllByTestId('velocity-bar')).toHaveLength(2);
  });

  it('guides capacity against the average and counts the carry-over', async () => {
    renderPage();

    const guidance = await screen.findByTestId('capacity-guidance');
    expect(guidance).toHaveTextContent(
      'Sprint 1 has 7 issues planned against an average of 5. That is 2 over what the team usually completes.'
    );
    expect(guidance).toHaveTextContent(
      '2 issues of that rolled over from the previous cycle.'
    );
  });

  it('reads in points for a team that estimates, with a switch back to issues', async () => {
    const user = userEvent.setup();
    getVelocity.mockResolvedValue({ ...velocity, estimate_scale: 'fibonacci' });
    renderPage();

    const guidance = await screen.findByTestId('capacity-guidance');
    expect(guidance).toHaveTextContent(
      'Sprint 1 has 9 points planned against an average of 10. There is room for about 1 more.'
    );

    await user.click(screen.getByRole('button', { name: 'Issues' }));

    expect(screen.getByTestId('capacity-guidance')).toHaveTextContent(
      '7 issues planned'
    );
  });

  it('waits for a closed cycle before charting', async () => {
    getVelocity.mockResolvedValue({ ...velocity, cycles: [], upcoming: null });
    renderPage();

    expect(
      await screen.findByText('Velocity shows once a cycle has closed.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('capacity-guidance')).toBeNull();
  });
});

describe('reading the list', () => {
  it('reads under the team the route names', async () => {
    renderPage();

    await waitFor(() => {
      expect(listCycles).toHaveBeenCalledWith({ team_id: 'proj-1' });
    });
  });

  it('leads with the running cycle, in full rather than as a row', async () => {
    renderPage();

    const card = within(
      await screen.findByRole('region', { name: 'Current cycle' })
    );
    expect(card.getByText('Sprint 1')).toBeInTheDocument();
    expect(card.getByText('Current')).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Sprint 1' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/cycles/cyc-1'
    );
    expect(card.getByText(/2026-09-01 to 2026-09-14/)).toBeInTheDocument();
    expect(card.getByText('Ship the engine')).toBeInTheDocument();
    expect(card.getByText(/4 issues/)).toBeInTheDocument();
  });

  it('draws a cycle that has not started as a row under Upcoming that opens it', async () => {
    listCycles.mockResolvedValue({
      cycles: [cycle, upcoming],
      next_cursor: null,
    });

    renderPage();

    const link = await screen.findByRole('link', { name: 'Sprint 2' });
    expect(link).toHaveAttribute('href', '/w/mine/team/ENG/cycles/cyc-2');
    const row = within(link.closest('li') as HTMLElement);
    expect(row.getByText(/2026-09-15 to 2026-09-28/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Upcoming/ })
    ).toBeInTheDocument();
  });

  it('keeps the past folded away until it is asked for', async () => {
    listCycles.mockResolvedValue({
      cycles: [{ ...upcoming, name: 'Sprint 0', status: 'completed' }],
      next_cursor: null,
    });

    renderPage();

    const group = await screen.findByRole('button', { name: /Past/ });
    expect(group).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Sprint 0')).not.toBeInTheDocument();

    await userEvent.click(group);

    expect(screen.getByText('Sprint 0')).toBeInTheDocument();
  });

  it('says so when the team has no cycles yet', async () => {
    listCycles.mockResolvedValue({ cycles: [], next_cursor: null });

    renderPage();

    expect(await screen.findByText(/No cycles yet/)).toBeInTheDocument();
  });

  it('shows the team is invisible rather than an empty list', async () => {
    listTeams.mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(
        'That team does not exist, or you are not a member of it.'
      )
    ).toBeInTheDocument();
  });
});

describe('writing', () => {
  it('creates without a status, which the server derives from the dates', async () => {
    renderPage();
    await screen.findByText('Sprint 1');
    await openCreate();

    await userEvent.type(screen.getByLabelText('Name'), 'Sprint 2');
    await userEvent.type(screen.getByLabelText('Start date'), '2026-09-15');
    await userEvent.type(screen.getByLabelText('End date'), '2026-09-28');
    await userEvent.click(screen.getByRole('button', { name: 'Create cycle' }));

    await waitFor(() => {
      expect(createCycle).toHaveBeenCalled();
    });
    const body = createCycle.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('status');
    expect(body?.team_id).toBe('proj-1');
    expect(body?.name).toBe('Sprint 2');
  });

  it('refuses to create until both dates are set', async () => {
    renderPage();
    await screen.findByText('Sprint 1');
    await openCreate();

    await userEvent.type(screen.getByLabelText('Name'), 'Sprint 2');

    expect(screen.getByRole('button', { name: 'Create cycle' })).toBeDisabled();
  });

  it('refuses an end date before the start date', async () => {
    renderPage();
    await screen.findByText('Sprint 1');
    await openCreate();

    await userEvent.type(screen.getByLabelText('Name'), 'Sprint 2');
    await userEvent.type(screen.getByLabelText('Start date'), '2026-09-28');
    await userEvent.type(screen.getByLabelText('End date'), '2026-09-15');

    expect(
      await screen.findByText('The end date cannot fall before the start date.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create cycle' })).toBeDisabled();
  });

  it('cancels a cycle through the team that names the row', async () => {
    listCycles.mockResolvedValue({ cycles: [upcoming], next_cursor: null });

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Cancel Sprint 2' })
    );

    await waitFor(() => {
      expect(updateCycle).toHaveBeenCalledWith('cyc-2', {
        team_id: 'proj-1',
        cancelled: true,
      });
    });
  });

  it('cancels the running cycle from its card', async () => {
    renderPage();

    const card = within(
      await screen.findByRole('region', { name: 'Current cycle' })
    );
    await userEvent.click(
      card.getByRole('button', { name: 'Cancel Sprint 1' })
    );

    await waitFor(() => {
      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        team_id: 'proj-1',
        cancelled: true,
      });
    });
  });

  it('offers to restore a cycle that was cancelled', async () => {
    listCycles.mockResolvedValue({
      cycles: [{ ...upcoming, cancelled: true, status: 'cancelled' }],
      next_cursor: null,
    });

    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: /Past/ }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Restore Sprint 2' })
    );

    await waitFor(() => {
      expect(updateCycle).toHaveBeenCalledWith('cyc-2', {
        team_id: 'proj-1',
        cancelled: false,
      });
    });
  });

  it('deletes as an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listCycles.mockResolvedValue({ cycles: [upcoming], next_cursor: null });

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete Sprint 2' })
    );

    await waitFor(() => {
      expect(deleteCycle).toHaveBeenCalledWith('cyc-2');
    });
  });
});

describe('what a role is offered', () => {
  it('draws no create or cancel control for a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...roleless } = team;
    listTeams.mockResolvedValue([roleless]);
    listCycles.mockResolvedValue({ cycles: [upcoming], next_cursor: null });

    renderPage();
    await screen.findByText('Sprint 2');

    expect(
      screen.queryByRole('button', { name: 'New cycle' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel Sprint 2' })
    ).not.toBeInTheDocument();
  });

  it('draws no delete control for a plain member', async () => {
    listCycles.mockResolvedValue({ cycles: [upcoming], next_cursor: null });

    renderPage();
    await screen.findByText('Sprint 2');

    expect(
      screen.queryByRole('button', { name: 'Delete Sprint 2' })
    ).not.toBeInTheDocument();
  });
});

describe('rolling up sub-teams', () => {
  /** A sub-team of the team above, on its parent's schedule. */
  const subTeam: TeamRead = {
    ...team,
    id: 'proj-2',
    name: 'Engine API',
    key_prefix: 'API',
    parent_team_id: 'proj-1',
  };

  /** The sub-team's cycle over the same days, with two more done issues. */
  const subCycle: CycleRead = {
    ...cycle,
    cycle_id: 'cyc-9',
    team_id: 'proj-2',
    name: 'API Sprint 1',
    counts: { todo: 0, in_progress: 0, done: 2, cancelled: 0, total: 2 },
  };

  beforeEach(() => {
    listTeams.mockResolvedValue([team, subTeam]);
    listCycles.mockResolvedValue({
      cycles: [cycle, subCycle],
      next_cursor: null,
    });
  });

  it('counts the sub-team issues in the matching cycle by default', async () => {
    renderPage();

    const card = within(
      await screen.findByRole('region', { name: 'Current cycle' })
    );
    expect(await card.findByText(/6 issues/)).toBeInTheDocument();
    expect(card.getByText('67%')).toBeInTheDocument();
    expect(listCycles).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 'proj-1', include_sub_teams: true })
    );
    expect(screen.queryByText('API Sprint 1')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Including sub-teams' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('narrows to the team alone from the toggle', async () => {
    const user = userEvent.setup();
    listCycles.mockImplementation((query) =>
      Promise.resolve({
        cycles:
          (query as { include_sub_teams?: boolean }).include_sub_teams === true
            ? [cycle, subCycle]
            : [cycle],
        next_cursor: null,
      })
    );
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Including sub-teams' })
    );

    const card = within(
      await screen.findByRole('region', { name: 'Current cycle' })
    );
    expect(await card.findByText(/4 issues/)).toBeInTheDocument();
    expect(listCycles).toHaveBeenLastCalledWith({ team_id: 'proj-1' });
    expect(
      screen.getByRole('button', { name: 'This team only' })
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('draws no toggle for a team without sub-teams', async () => {
    listTeams.mockResolvedValue([team]);
    listCycles.mockResolvedValue({ cycles: [cycle], next_cursor: null });
    renderPage();

    await screen.findByRole('region', { name: 'Current cycle' });
    expect(screen.queryByTestId('sub-team-roll-up')).toBeNull();
  });
});
