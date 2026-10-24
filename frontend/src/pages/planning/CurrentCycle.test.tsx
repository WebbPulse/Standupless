/**
 * The current cycle address. Covers that it replaces itself with the team's
 * running cycle, that it follows the cursor past a page with no running
 * cycle, and that it falls back to the cycles list with a notice when none
 * runs, when the read fails, or when the team does not exist.
 */

import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CycleListQuery,
  CycleListRead,
  CycleRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import CurrentCycle from './CurrentCycle';

const listCycles = vi.fn<(query: CycleListQuery) => Promise<CycleListRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const showToast = vi.fn<(message: string) => number>();
const showErrorToast = vi.fn<(message: string) => number>();

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: CycleListQuery) => listCycles(query),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
}));

vi.mock('../../lib/toast', () => ({
  showToast: (message: string) => showToast(message),
  showErrorToast: (message: string) => showErrorToast(message),
}));

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
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

const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: (): WorkspaceContextType => ({
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: () => Promise.resolve(),
  }),
}));

const team: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const running: CycleRead = {
  cycle_id: 'cyc-2',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  name: 'Sprint 2',
  start_date: '2026-10-19',
  end_date: '2026-11-01',
  goal: null,
  cancelled: false,
  status: 'active',
  counts: { todo: 1, in_progress: 0, done: 0, cancelled: 0, total: 1 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
};

/** Renders the address with stand-ins for where it can send the reader. */
const renderPage = (entry = '/w/mine/team/ENG/cycles/current') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/team/:keyPrefix/cycles" element={<p>List</p>} />
        <Route
          path="/w/:slug/team/:keyPrefix/cycles/current"
          element={<CurrentCycle />}
        />
        <Route
          path="/w/:slug/team/:keyPrefix/cycles/:cycleId"
          element={<p>Cycle page</p>}
        />
      </Routes>
    </MemoryRouter>
  );

describe('CurrentCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTeams.mockResolvedValue([team]);
  });

  it("opens the team's running cycle", async () => {
    listCycles.mockResolvedValue({ cycles: [running], next_cursor: null });

    renderPage();

    expect(await screen.findByText('Cycle page')).toBeInTheDocument();
    expect(listCycles).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 'team-1', status: 'active' })
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it('follows the cursor past a page with no running cycle', async () => {
    listCycles
      .mockResolvedValueOnce({ cycles: [], next_cursor: 'page-2' })
      .mockResolvedValueOnce({ cycles: [running], next_cursor: null });

    renderPage();

    expect(await screen.findByText('Cycle page')).toBeInTheDocument();
    expect(listCycles).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'page-2' })
    );
  });

  it('falls back to the cycles list with a notice when none runs', async () => {
    listCycles.mockResolvedValue({ cycles: [], next_cursor: null });

    renderPage();

    expect(await screen.findByText('List')).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith(
      'No cycle is running in Engine right now.'
    );
  });

  it('falls back to the cycles list when the read fails', async () => {
    listCycles.mockRejectedValue(new Error('boom'));

    renderPage();

    expect(await screen.findByText('List')).toBeInTheDocument();
    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalled();
    });
  });

  it('sends an unknown team to its cycles list', async () => {
    renderPage('/w/mine/team/NOPE/cycles/current');

    expect(await screen.findByText('List')).toBeInTheDocument();
    expect(listCycles).not.toHaveBeenCalled();
  });
});
