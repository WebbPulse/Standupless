/**
 * One cycle's page. Covers that the cycle is read under the team the route
 * names, that it shows the scope, started and completed counts and a
 * burn-up, that its issues are read by cycle, and that a new issue opens
 * the dialog filed into the cycle. The burn-up reads the recorded history
 * with a projection, switches to points for a team that estimates, and the
 * carry-over reads in a line under the stats. A parent team's cycle rolls up
 * its sub-teams' cycles on the same dates, in the header, the chart and the
 * issues, until the toggle narrows it to the team alone, and an empty cycle
 * says so rather than drawing an empty chart. A cycle left with its generated
 * name reads as its number, and the side panel's breakdown filters the list.
 * The name, goal and dates edit in place with an optimistic save that rolls
 * back on failure, an end before the start is refused, and a closed cycle
 * reads only. A cycle that has not started carries the capacity dial in its
 * header, read against the team's last three closed cycles. The header's
 * actions menu ends a running cycle today and starts the next upcoming one
 * today behind their confirms, cancels a cycle, and deletes one for an admin
 * before returning to the team's cycles.
 */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CycleHistoryRead,
  CycleListRead,
  CycleRead,
  CycleUpdate,
  IssueListRead,
  IssueRead,
  StatusRead,
  TeamRead,
  VelocityRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import CycleDetail from './CycleDetail';

const getCycle =
  vi.fn<(id: string, teamId: string) => Promise<CycleRead | null>>();
const getCycleHistory =
  vi.fn<(id: string, teamId: string) => Promise<CycleHistoryRead>>();
const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();
const updateCycle =
  vi.fn<(id: string, body: CycleUpdate) => Promise<CycleRead>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const getVelocity = vi.fn<(teamId: string) => Promise<VelocityRead>>();
const startCycleToday =
  vi.fn<(id: string, teamId: string) => Promise<unknown>>();
const endCycleToday =
  vi.fn<(id: string, teamId: string) => Promise<CycleRead>>();
const deleteCycle = vi.fn<(id: string, teamId: string) => Promise<void>>();

/** One closed cycle that finished four issues, with nothing being planned. */
const velocity: VelocityRead = {
  team_id: 'proj-1',
  estimate_scale: 'off',
  cycles: [
    {
      cycle_id: 'old-1',
      name: 'Sprint 0',
      start_date: '2026-08-15',
      end_date: '2026-08-28',
      completed_issues: 4,
      completed_points: 0,
      scope_issues: 5,
      scope_points: 0,
      carried_out: 1,
      carried_out_points: 0,
    },
  ],
  average_points: 0,
  average_issues: 4,
  upcoming: null,
};

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
  updateCycle: (_w: string, id: string, body: CycleUpdate) =>
    updateCycle(id, body),
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
  getVelocity: (_w: string, teamId: string) => getVelocity(teamId),
  startCycleToday: (_w: string, id: string, teamId: string) =>
    startCycleToday(id, teamId),
  endCycleToday: (_w: string, id: string, teamId: string) =>
    endCycleToday(id, teamId),
  deleteCycle: (_w: string, id: string, teamId: string) =>
    deleteCycle(id, teamId),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve(statuses),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
}));

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listIssues: (_w: string, query: unknown) => listIssues(query),
    appendIssues: (held: unknown) => held,
  };
});

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
        <Route
          path="/w/:slug/team/:keyPrefix/cycles"
          element={<p>Team cycles</p>}
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
  await screen.findByDisplayValue('Ship the engine');
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
    getVelocity.mockResolvedValue(velocity);
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
    listCycles.mockResolvedValue({ cycles: [cycle], next_cursor: null });
    startCycleToday.mockResolvedValue({});
    endCycleToday.mockResolvedValue(cycle);
    deleteCycle.mockResolvedValue(undefined);
    updateCycle.mockImplementation((_id, body) =>
      Promise.resolve({
        ...cycle,
        ...body,
        goal: body.goal === undefined ? cycle.goal : body.goal,
        updated_at: '2026-09-19T00:00:00Z',
      })
    );
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

    expect(
      await screen.findByDisplayValue('Ship the engine')
    ).toBeInTheDocument();
    expect(getCycle).toHaveBeenCalledWith('cyc-1', 'proj-1');
    expect(screen.getAllByText('Scope').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Started').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getByText('50% complete')).toBeInTheDocument();
  });

  it('titles a cycle left with its generated name by its number', async () => {
    getCycle.mockResolvedValue({ ...cycle, name: 'auto-20260901', number: 3 });
    renderPage();

    expect(
      await screen.findByRole('textbox', { name: 'Cycle name' })
    ).toHaveValue('Cycle 3');
    expect(screen.queryByDisplayValue('auto-20260901')).toBeNull();
  });

  it('breaks the issues down and filters the list from a row', async () => {
    const user = userEvent.setup();
    listIssues.mockResolvedValue({ issues: [openIssue], next_cursor: null });
    renderPage();

    const row = await screen.findByRole('button', {
      name: 'No assignee, 0 of 1 done',
    });
    expect(row).toHaveAttribute('aria-pressed', 'false');
    await user.click(row);

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ cycle_id: 'cyc-1', assignee_id: ['none'] })
      );
    });
    expect(
      screen.getByRole('button', { name: 'No assignee, 0 of 1 done' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('breaks the issues down by priority and filters the list from a row', async () => {
    const user = userEvent.setup();
    listIssues.mockResolvedValue({
      issues: [{ ...openIssue, priority: 'high' }],
      next_cursor: null,
    });
    renderPage();

    await user.click(await screen.findByRole('tab', { name: 'Priorities' }));
    const row = await screen.findByRole('button', {
      name: 'High, 0 of 1 done',
    });
    expect(row).toHaveAttribute('aria-pressed', 'false');
    await user.click(row);

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ cycle_id: 'cyc-1', priority: ['high'] })
      );
    });
    expect(
      screen.getByRole('button', { name: 'High, 0 of 1 done' })
    ).toHaveAttribute('aria-pressed', 'true');
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

  it('shows the capacity dial for a cycle that has not started', async () => {
    getCycle.mockResolvedValue({ ...cycle, status: 'upcoming' });
    renderPage();

    expect(
      await screen.findByRole('img', {
        name: 'Capacity: 4 of 4 issues, based on the last cycle',
      })
    ).toBeInTheDocument();
    expect(getVelocity).toHaveBeenCalledWith('proj-1');
  });

  it('draws no capacity dial once the cycle has started', async () => {
    renderPage();

    await historyRequested();
    expect(screen.queryByTestId('capacity-dial')).not.toBeInTheDocument();
    expect(getVelocity).not.toHaveBeenCalled();
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

  it('shows a placeholder, not the empty message, while the history loads', async () => {
    getCycleHistory.mockReturnValue(new Promise<never>(() => undefined));
    renderPage();

    expect(await screen.findByTestId('burn-up-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('burn-up-empty')).toBeNull();
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
      const teamAlone = listIssues.mock.calls
        .map(([query]) => query as { team_id?: unknown; cycle_id?: unknown })
        .filter(
          (query) => query.team_id === 'proj-1' && query.cycle_id === 'cyc-1'
        );
      expect(teamAlone.length).toBeGreaterThan(0);
      for (const query of teamAlone) {
        expect(query).not.toHaveProperty('include_sub_teams');
      }
    });

    it('reads the team alone from a narrowed link', async () => {
      renderPage('/w/mine/team/ENG/cycles/cyc-1?subteams=0');

      expect(await screen.findByText('50% complete')).toBeInTheDocument();
      expect(listCycles).not.toHaveBeenCalledWith(
        expect.objectContaining({ include_sub_teams: true })
      );
      expect(
        screen.getByRole('button', { name: 'This team only' })
      ).toBeInTheDocument();
    });
  });

  describe('editing in place', () => {
    it('renames the cycle on Enter', async () => {
      const user = userEvent.setup();
      renderPage();
      const name = await screen.findByRole('textbox', { name: 'Cycle name' });

      await user.clear(name);
      await user.type(name, 'Launch{Enter}');

      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        team_id: 'proj-1',
        name: 'Launch',
      });
      expect(name).toHaveValue('Launch');
    });

    it('drops the draft on Escape', async () => {
      const user = userEvent.setup();
      renderPage();
      const name = await screen.findByRole('textbox', { name: 'Cycle name' });

      await user.type(name, ' later{Escape}');

      expect(updateCycle).not.toHaveBeenCalled();
      expect(name).toHaveValue('Sprint 1');
    });

    it('falls back to the readable name when the name is cleared', async () => {
      const user = userEvent.setup();
      getCycle.mockResolvedValue({ ...cycle, number: 4 });
      renderPage();
      const name = await screen.findByRole('textbox', { name: 'Cycle name' });

      await user.clear(name);
      await user.tab();

      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        team_id: 'proj-1',
        name: 'Cycle 4',
      });
    });

    it('sets and clears the goal', async () => {
      const user = userEvent.setup();
      renderPage();
      const goal = await screen.findByRole('textbox', { name: 'Cycle goal' });
      expect(goal).toHaveAttribute('placeholder', 'Add a cycle goal');

      await user.clear(goal);
      await user.tab();

      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        team_id: 'proj-1',
        goal: null,
      });
    });

    it('moves the end date from the picker', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(
        await screen.findByRole('button', { name: /^End date:/ })
      );
      fireEvent.change(screen.getByLabelText('Custom date'), {
        target: { value: '2026-09-21' },
      });

      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        team_id: 'proj-1',
        end_date: '2026-09-21',
      });
    });

    it('refuses an end date before the start', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(
        await screen.findByRole('button', { name: /^End date:/ })
      );
      fireEvent.change(screen.getByLabelText('Custom date'), {
        target: { value: '2026-08-20' },
      });

      expect(
        await screen.findByText(
          'The end date cannot fall before the start date.'
        )
      ).toBeInTheDocument();
      expect(updateCycle).not.toHaveBeenCalled();
    });

    it('rolls a failed save back', async () => {
      const user = userEvent.setup();
      updateCycle.mockRejectedValue(new Error('offline'));
      renderPage();
      const name = await screen.findByRole('textbox', { name: 'Cycle name' });

      await user.clear(name);
      await user.type(name, 'Launch{Enter}');

      await waitFor(() => {
        expect(name).toHaveValue('Sprint 1');
      });
    });

    it('keeps a completed cycle read only', async () => {
      getCycle.mockResolvedValue({ ...cycle, status: 'completed' });
      renderPage();

      expect(await screen.findByText('Ship the engine')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Cycle name' })).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Cycle goal' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^End date:/ })).toBeNull();
    });
  });
  describe('the actions menu', () => {
    /** Opens the header's actions menu and picks one item from it. */
    const pick = async (action: string): Promise<void> => {
      await userEvent.click(
        await screen.findByRole('button', { name: 'Sprint 1 actions' })
      );
      await userEvent.click(
        await screen.findByRole('menuitem', { name: action })
      );
    };

    it('ends the running cycle today behind the rollover confirm', async () => {
      renderPage();

      await pick('End cycle today');
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent(
        'Its 2 unfinished issues will roll into the next cycle.'
      );
      await userEvent.click(
        screen.getByRole('button', { name: 'End Sprint 1 today' })
      );

      await waitFor(() => {
        expect(endCycleToday).toHaveBeenCalledWith('cyc-1', 'proj-1');
      });
      expect(
        screen.queryByRole('menuitem', { name: 'Start cycle today' })
      ).toBeNull();
    });

    it('starts the next upcoming cycle today, naming the issues that move', async () => {
      const next = { ...cycle, status: 'upcoming' as const };
      getCycle.mockResolvedValue(next);
      listCycles.mockResolvedValue({
        cycles: [
          next,
          { ...cycle, cycle_id: 'cyc-0', name: 'Sprint 0', status: 'active' },
        ],
        next_cursor: null,
      });
      renderPage();

      await waitFor(() => {
        expect(listCycles).toHaveBeenCalledWith({ team_id: 'proj-1' });
      });
      await pick('Start cycle today');
      expect(await screen.findByRole('dialog')).toHaveTextContent(
        '2 open issues will move from Sprint 0 into Sprint 1.'
      );
      await userEvent.click(
        screen.getByRole('button', { name: 'Start Sprint 1' })
      );

      await waitFor(() => {
        expect(startCycleToday).toHaveBeenCalledWith('cyc-1', 'proj-1');
      });
    });

    it('cancels the cycle', async () => {
      renderPage();

      await pick('Cancel cycle');

      await waitFor(() => {
        expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
          team_id: 'proj-1',
          cancelled: true,
        });
      });
    });

    it('offers delete only to an admin', async () => {
      renderPage();

      await userEvent.click(
        await screen.findByRole('button', { name: 'Sprint 1 actions' })
      );
      expect(
        await screen.findByRole('menuitem', { name: 'Copy link' })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: 'Delete cycle' })
      ).toBeNull();
    });

    it('deletes the cycle for an admin and returns to the team cycles', async () => {
      useWorkspaceMock.mockReturnValue(resolved('admin'));
      renderPage();

      await pick('Delete cycle');
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Delete Sprint 1' })
      );

      await waitFor(() => {
        expect(deleteCycle).toHaveBeenCalledWith('cyc-1', 'proj-1');
      });
      expect(await screen.findByText('Team cycles')).toBeInTheDocument();
    });
  });
});
