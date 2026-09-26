/**
 * One cycle's page. Covers that the cycle is read under the team the route
 * names, that it shows the scope, started and completed counts and a
 * burn-up, that its issues are read by cycle, and that a new issue opens
 * the dialog filed into the cycle. The burn-up reads the recorded history
 * with a projection, switches to points for a team that estimates, and the
 * carry-over reads in a line under the stats.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CycleHistoryRead,
  CycleRead,
  IssueListRead,
  StatusRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import CycleDetail from './CycleDetail';

const getCycle =
  vi.fn<(id: string, teamId: string) => Promise<CycleRead | null>>();
const getCycleHistory =
  vi.fn<(id: string, teamId: string) => Promise<CycleHistoryRead>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

const statuses: StatusRead[] = [
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'done', name: 'Done', category: 'completed', position: 1 },
];

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
  getCycle: (_w: string, id: string, teamId: string) => getCycle(id, teamId),
  getCycleHistory: (_w: string, id: string, teamId: string) =>
    getCycleHistory(id, teamId),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve(statuses),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
}));

vi.mock('../../api/issues', () => ({
  listIssues: (_w: string, query: unknown) => listIssues(query),
  appendIssues: (held: unknown) => held,
}));

const open = vi.fn();

vi.mock('../../hooks/useCreateIssue', () => ({
  useCreateIssue: () => ({
    open,
    close: vi.fn(),
    isOpen: false,
    canCreate: true,
    request: null,
  }),
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

/** One recorded day in both measures, points twice the count. */
const day = (
  date: string,
  scope: number,
  started: number,
  completed: number
) => ({
  date,
  scope,
  started,
  completed,
  scope_points: scope * 2,
  started_points: started * 2,
  completed_points: completed * 2,
});

const history: CycleHistoryRead = {
  cycle_id: 'cyc-1',
  team_id: 'proj-1',
  start_date: '2026-09-01',
  end_date: '2026-09-14',
  status: 'active',
  today: '2026-09-04',
  days: [
    day('2026-09-01', 4, 0, 0),
    day('2026-09-02', 4, 1, 1),
    day('2026-09-03', 4, 2, 1),
    day('2026-09-04', 4, 3, 2),
  ],
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
    <MemoryRouter initialEntries={['/w/mine/team/ENG/cycles/cyc-1']}>
      <Routes>
        <Route
          path="/w/:slug/team/:keyPrefix/cycles/:cycleId"
          element={<CycleDetail />}
        />
      </Routes>
    </MemoryRouter>
  );

/**
 * Waits for the reads the page makes one after another: the team and the
 * cycle, which the header shows, then the history, which the page asks for
 * only once it holds the cycle. Each wait covers one read, so a slow first
 * render does not spend the whole budget of a single wait on the chain.
 */
const historyRequested = async (): Promise<void> => {
  await screen.findByText('Ship the engine');
  await waitFor(() => {
    expect(getCycleHistory).toHaveBeenCalled();
  });
};

describe('CycleDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listTeams.mockResolvedValue([team]);
    getCycle.mockResolvedValue(cycle);
    getCycleHistory.mockResolvedValue(history);
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
  });

  it('draws the recorded history with a projection once a few days are in', async () => {
    renderPage();

    await historyRequested();
    expect(getCycleHistory).toHaveBeenCalledWith('cyc-1', 'proj-1');
    const chart = await screen.findByRole('img', {
      name: /completed 2 issues as of 2026-09-04\. Projected/,
    });
    expect(chart).toBeInTheDocument();
    expect(screen.getByTestId('burn-up-projection')).toBeInTheDocument();
    expect(screen.getByTestId('projection-label')).toHaveTextContent(
      'On pace to finish the scope'
    );
  });

  it('draws no projection on too little history', async () => {
    getCycleHistory.mockResolvedValue({
      ...history,
      days: history.days.slice(0, 2),
    });
    renderPage();

    await historyRequested();
    await screen.findByRole('img', { name: /as of 2026-09-02/ });
    expect(screen.queryByTestId('burn-up-projection')).toBeNull();
  });

  it('offers no points switch to a team that does not estimate', async () => {
    renderPage();

    await screen.findByRole('img', { name: /^Burn-up chart/ });
    expect(screen.queryByRole('group', { name: 'Burn-up measure' })).toBeNull();
  });

  it('switches the burn-up to points for a team that estimates', async () => {
    const user = userEvent.setup();
    listTeams.mockResolvedValue([{ ...team, estimate_scale: 'fibonacci' }]);
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Points' }));

    expect(
      await screen.findByRole('img', { name: /completed 4 points as of/ })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Points' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('says what was carried in and out', async () => {
    getCycle.mockResolvedValue({
      ...cycle,
      carry: {
        carried_in: 2,
        carried_in_points: 5,
        carried_out: 1,
        carried_out_points: 3,
      },
    });
    renderPage();

    expect(await screen.findByTestId('carry-over')).toHaveTextContent(
      '2 issues carried in from the last cycle · 1 issue carried over to the next cycle'
    );
  });

  it('falls back to the issues when the history cannot be read', async () => {
    getCycleHistory.mockRejectedValue(new Error('offline'));
    renderPage();

    await historyRequested();
    expect(
      await screen.findByRole('img', { name: /^Burn-up chart/ })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('burn-up-projection')).toBeNull();
  });

  it('reads the cycle under the team the route names', async () => {
    renderPage();

    expect(await screen.findByText('Ship the engine')).toBeInTheDocument();
    expect(getCycle).toHaveBeenCalledWith('cyc-1', 'proj-1');
    expect(screen.getAllByText('Scope').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Started').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getByText('50% complete')).toBeInTheDocument();
  });

  it('draws the burn-up for a cycle that has begun', async () => {
    renderPage();

    expect(
      await screen.findByRole('img', { name: /^Burn-up chart/ })
    ).toBeInTheDocument();
  });

  it('waits for an upcoming cycle to begin before charting', async () => {
    getCycle.mockResolvedValue({ ...cycle, status: 'upcoming' });
    renderPage();

    expect(
      await screen.findByText(/burn-up starts drawing once the cycle begins/)
    ).toBeInTheDocument();
  });

  it('reads the issues by cycle', async () => {
    renderPage();

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: 'proj-1', cycle_id: 'cyc-1' })
      );
    });
  });

  it('opens the new issue dialog filed into the cycle', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New issue' }));

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'proj-1', cycleId: 'cyc-1' })
    );
  });

  it('does not offer new issues in a completed cycle', async () => {
    getCycle.mockResolvedValue({ ...cycle, status: 'completed' });
    renderPage();

    await screen.findByText('Ship the engine');
    expect(screen.queryByRole('button', { name: 'New issue' })).toBeNull();
  });

  it('reports a cycle it cannot read', async () => {
    getCycle.mockResolvedValue(null);
    renderPage();

    expect(
      await screen.findByText(/That cycle does not exist/)
    ).toBeInTheDocument();
  });
});
