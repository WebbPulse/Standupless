/**
 * One cycle's page. Covers that the cycle is read under the team the route
 * names, that it shows the scope, started and completed counts and a
 * burn-up, that its issues are read by cycle, and that a new issue opens
 * the dialog filed into the cycle.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
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

describe('CycleDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listTeams.mockResolvedValue([team]);
    getCycle.mockResolvedValue(cycle);
    listIssues.mockResolvedValue({ issues: [], next_cursor: null });
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
