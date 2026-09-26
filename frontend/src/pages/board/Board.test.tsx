/**
 * The board page. Covers the filter conversions a saved view round trips
 * through, and that applying a stored view re-reads the board under the stored
 * filter rather than reading issues by a second path.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  BoardRead,
  LabelRead,
  TeamMemberRead,
  TeamRead,
  SavedViewRead,
  WorkspaceRead,
} from '../../types/Api';
import Board from './Board';
import { fromViewFilter, toViewFilter } from '../../lib/viewFilters';

const getBoard = vi.fn<(query: unknown) => Promise<BoardRead>>();
const listViews = vi.fn<() => Promise<SavedViewRead[]>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const listTeamMembers = vi.fn<() => Promise<TeamMemberRead[]>>();

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

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    getBoard: (_w: string, _p: string, query: unknown) => getBoard(query),
    listViews: () => listViews(),
  };
});

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listLabels: () => listLabels(),
  listTeamMembers: () => listTeamMembers(),
  listStatuses: () => Promise.resolve([]),
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

const resolved = (): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
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
    <MemoryRouter initialEntries={['/w/mine/team/ENG/board']}>
      <Routes>
        <Route path="/w/:slug/team/:keyPrefix/board" element={<Board />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  getBoard.mockReset();
  listViews.mockReset();
  listTeams.mockReset();
  listLabels.mockReset();
  listTeamMembers.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listTeams.mockResolvedValue([team]);
  listLabels.mockResolvedValue([]);
  listTeamMembers.mockResolvedValue([]);
  listViews.mockResolvedValue([]);
  getBoard.mockResolvedValue({
    team_id: 'proj-1',
    columns: [
      {
        status_id: 'st-todo',
        name: 'To do',
        category: 'unstarted',
        position: 0,
        issues: [],
        total: 0,
        next_cursor: null,
      },
    ],
  });
});

describe('view filter conversions', () => {
  it('writes only the keys a person actually set', () => {
    expect(
      toViewFilter({ assigneeId: 'user-1', labelId: '', priority: '' })
    ).toEqual({ assignee_id: 'user-1' });
  });

  it('writes nothing at all when the board is unfiltered', () => {
    expect(toViewFilter({ assigneeId: '', labelId: '', priority: '' })).toEqual(
      {}
    );
  });

  it('reads a stored filter back into the board state', () => {
    expect(
      fromViewFilter({ assignee_id: 'user-1', priority: 'urgent' })
    ).toEqual({ assigneeId: 'user-1', labelId: '', priority: 'urgent' });
  });

  it('narrows a stored list to the one value the board reads under', () => {
    expect(fromViewFilter({ label_id: ['lab-1', 'lab-2'] })).toEqual({
      assigneeId: '',
      labelId: 'lab-1',
      priority: '',
    });
  });

  it('ignores a key the board does not filter on', () => {
    expect(fromViewFilter({ cycle_id: 'cyc-1' })).toEqual({
      assigneeId: '',
      labelId: '',
      priority: '',
    });
  });

  it('round trips a filter through both conversions', () => {
    const filters = {
      assigneeId: 'user-1',
      labelId: 'lab-1',
      priority: 'high',
    };
    expect(fromViewFilter(toViewFilter(filters))).toEqual(filters);
  });
});

describe('board page', () => {
  it('names the team it is showing', async () => {
    renderPage();

    const main = within(screen.getByRole('main'));
    expect(await main.findByText('Engine')).toBeInTheDocument();
    expect(main.getByText('ENG')).toBeInTheDocument();
  });

  it('says so when the key prefix matches no team', async () => {
    listTeams.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(
        'That team does not exist, or you are not a member of it.'
      )
    ).toBeInTheDocument();
  });

  it('re-reads the board when a filter changes', async () => {
    const user = userEvent.setup();
    listTeamMembers.mockResolvedValue([
      {
        user_id: 'user-1',
        email: 'ada@example.com',
        display_name: 'Ada',
        role: 'member',
        added_at: '2026-09-17T00:00:00Z',
      },
    ]);
    renderPage();

    await within(screen.getByRole('main')).findByText('Engine');
    await screen.findByRole('option', { name: 'Ada' });
    await user.selectOptions(screen.getByLabelText('Assignee'), 'user-1');

    await waitFor(() => {
      expect(getBoard).toHaveBeenCalledWith(
        expect.objectContaining({ assignee_id: 'user-1' })
      );
    });
  });

  it('applies a saved view by re-reading the board under its filter', async () => {
    const user = userEvent.setup();
    listViews.mockResolvedValue([
      {
        view_id: 'v-1',
        workspace_id: 'ws-1',
        name: 'Urgent only',
        kind: 'board',
        scope: 'personal',
        team_id: null,
        filter: { priority: 'urgent' },
        sort: 'updated_desc',
        group_by: null,
        owner_id: 'user-1',
        created_at: '2026-09-17T00:00:00Z',
        updated_at: '2026-09-17T00:00:00Z',
      },
    ]);
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Urgent only' })
    );

    await waitFor(() => {
      expect(getBoard).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'urgent' })
      );
    });
  });
});
