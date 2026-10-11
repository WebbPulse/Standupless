/**
 * One cycle's page. Covers that the cycle is read under the team the route
 * names, that it shows the scope, started and completed counts and a
 * burn-up, that its issues are read by cycle, and that a new issue opens
 * the dialog filed into the cycle. The burn-up reads the recorded history
 * with a projection, switches to points for a team that estimates, and the
 * carry-over reads in a line under the stats. A parent team's cycle rolls up
 * its sub-teams' cycles on the same dates, in the header, the chart and the
 * issues, until the toggle narrows it to the team alone, and an empty cycle
 * says so rather than drawing an empty chart.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CycleHistoryRead,
  CycleListRead,
  CycleRead,
  IssueListRead,
  IssueRead,
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
const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();
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
  listCycles: (_w: string, query: unknown) => listCycles(query),
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

/** A sub-team of the team above, so its cycles roll up into the parent's. */
const subTeam: TeamRead = {
  ...team,
  id: 'proj-2',
  name: 'Engine API',
  key_prefix: 'API',
  parent_team_id: 'proj-1',
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

/** The sub-team's cycle over the same days, with two done issues. */
const subCycle: CycleRead = {
  ...cycle,
  cycle_id: 'cyc-2',
  team_id: 'proj-2',
  goal: null,
  counts: { todo: 0, in_progress: 0, done: 2, cancelled: 0, total: 2 },
};

/** The sub-team's history over the same days, both issues done on the second. */
const subHistory: CycleHistoryRead = {
  ...history,
  cycle_id: 'cyc-2',
  team_id: 'proj-2',
  days: [
    day('2026-09-01', 2, 0, 0),
    day('2026-09-02', 2, 2, 2),
    day('2026-09-03', 2, 2, 2),
    day('2026-09-04', 2, 2, 2),
  ],
};

/** One open issue in the cycle, created on its first day. */
const openIssue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  key: 'ENG-1',
  number: 1,
  title: 'Tune the engine',
  body: null,
  status_id: 'todo',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: 'cyc-1',
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-01T09:00:00Z',
  updated_at: '2026-09-01T09:00:00Z',
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

const renderPage = (entry = '/w/mine/team/ENG/cycles/cyc-1') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
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
    listCycles.mockResolvedValue({ cycles: [cycle], next_cursor: null });
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
      '2 issues rolled over from the previous cycle · 1 issue rolled over to the next cycle'
    );
  });

  it('falls back to the issues when the history cannot be read', async () => {
    getCycleHistory.mockRejectedValue(new Error('offline'));
    listIssues.mockResolvedValue({ issues: [openIssue], next_cursor: null });
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

  it('says an empty cycle has nothing to chart', async () => {
    getCycle.mockResolvedValue({
      ...cycle,
      counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
    });
    getCycleHistory.mockResolvedValue({
      ...history,
      days: history.days.map((row) => day(row.date, 0, 0, 0)),
    });
    renderPage();

    expect(await screen.findByTestId('burn-up-empty')).toHaveTextContent(
      'No issues in this cycle yet'
    );
    expect(screen.queryByRole('img', { name: /^Burn-up chart/ })).toBeNull();
  });

  it('labels a one-issue cycle 0 and 1 on the y axis', async () => {
    getCycle.mockResolvedValue({
      ...cycle,
      counts: { todo: 1, in_progress: 0, done: 0, cancelled: 0, total: 1 },
    });
    getCycleHistory.mockResolvedValue({
      ...history,
      days: history.days.map((row) => day(row.date, 1, 0, 0)),
    });
    renderPage();

    await screen.findByRole('img', { name: /^Burn-up chart/ });
    expect(
      screen.getAllByTestId('burn-up-tick').map((node) => node.textContent)
    ).toEqual(['0', '1']);
  });

  describe('with a sub-team', () => {
    beforeEach(() => {
      listTeams.mockResolvedValue([team, subTeam]);
      listCycles.mockResolvedValue({
        cycles: [cycle, subCycle],
        next_cursor: null,
      });
      getCycleHistory.mockImplementation((id) =>
        Promise.resolve(id === 'cyc-2' ? subHistory : history)
      );
    });

    it('rolls the sub-team cycle on the same dates into the header, chart and issues', async () => {
      renderPage();

      expect(await screen.findByText('67% complete')).toBeInTheDocument();
      expect(listCycles).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: 'proj-1', include_sub_teams: true })
      );
      await waitFor(() => {
        expect(getCycleHistory).toHaveBeenCalledWith('cyc-2', 'proj-2');
      });
      expect(
        await screen.findByRole('img', {
          name: /Scope 6, started 5, completed 4 issues as of 2026-09-04/,
        })
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(listIssues).toHaveBeenCalledWith(
          expect.objectContaining({
            team_id: 'proj-1',
            include_sub_teams: true,
            cycle_id: ['cyc-1', 'cyc-2'],
          })
        );
      });
      expect(
        screen.getByRole('button', { name: 'Including sub-teams' })
      ).toHaveAttribute('aria-pressed', 'true');
    });

    it('ignores a sub-team cycle on other dates', async () => {
      listCycles.mockResolvedValue({
        cycles: [cycle, { ...subCycle, start_date: '2026-09-15' }],
        next_cursor: null,
      });
      renderPage();

      await screen.findByRole('button', { name: 'Including sub-teams' });
      await waitFor(() => {
        expect(listCycles).toHaveBeenCalled();
      });
      expect(await screen.findByText('50% complete')).toBeInTheDocument();
      expect(getCycleHistory).not.toHaveBeenCalledWith('cyc-2', 'proj-2');
    });

    it('narrows to the team alone from the toggle', async () => {
      const user = userEvent.setup();
      renderPage();

      await screen.findByText('67% complete');
      await user.click(
        screen.getByRole('button', { name: 'Including sub-teams' })
      );

      expect(await screen.findByText('50% complete')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'This team only' })
      ).toHaveAttribute('aria-pressed', 'false');
      await waitFor(() => {
        expect(listIssues).toHaveBeenLastCalledWith(
          expect.objectContaining({ team_id: 'proj-1', cycle_id: 'cyc-1' })
        );
      });
      expect(listIssues.mock.lastCall?.[0]).not.toHaveProperty(
        'include_sub_teams'
      );
    });

    it('reads the team alone from a narrowed link', async () => {
      renderPage('/w/mine/team/ENG/cycles/cyc-1?subteams=0');

      expect(await screen.findByText('50% complete')).toBeInTheDocument();
      expect(listCycles).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: 'This team only' })
      ).toBeInTheDocument();
    });
  });
});
