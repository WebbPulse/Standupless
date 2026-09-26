/**
 * The cycles page. Covers that the list is read under the team the route
 * names, that the running cycle leads the page while the rest group into
 * upcoming and past, that creating sends no status because the server derives
 * it, and that the controls a role may not use are not drawn.
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
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Cycles from './Cycles';

const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();
const createCycle = vi.fn<(body: CycleCreate) => Promise<CycleRead>>();
const updateCycle = vi.fn<(id: string, body: unknown) => Promise<CycleRead>>();
const deleteCycle = vi.fn<(id: string) => Promise<void>>();
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

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: unknown) => listCycles(query),
  createCycle: (_w: string, body: CycleCreate) => createCycle(body),
  updateCycle: (_w: string, id: string, body: unknown) => updateCycle(id, body),
  deleteCycle: (_w: string, id: string) => deleteCycle(id),
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/cycles']}>
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
