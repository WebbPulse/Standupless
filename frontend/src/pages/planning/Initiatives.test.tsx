/**
 * The initiatives list. Covers that rows group by status with their project
 * count and progress, that a member creates an initiative owned by them and
 * lands on it, that an empty workspace explains what an initiative is, and that
 * a guest is told initiatives are for members and offered no way to start one.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  InitiativeCreate,
  InitiativeListRead,
  InitiativeRead,
  MemberRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Initiatives from './Initiatives';

const listInitiatives = vi.fn<() => Promise<InitiativeListRead>>();
const createInitiative =
  vi.fn<(body: InitiativeCreate) => Promise<InitiativeRead>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: {
      id: 'user-1',
      email: 'ada@example.com',
      display_name: 'Ada Lovelace',
    },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/initiatives', () => ({
  listInitiatives: () => listInitiatives(),
  createInitiative: (_w: string, body: InitiativeCreate) =>
    createInitiative(body),
}));

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return { ...actual, listMembers: () => listMembers() };
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

/** Builds an initiative with an empty rollup. */
const initiative = (
  id: string,
  name: string,
  overrides: Partial<InitiativeRead> = {}
): InitiativeRead => ({
  initiative_id: id,
  workspace_id: 'ws-1',
  name,
  description: null,
  owner_id: null,
  status: 'planned',
  health: null,
  target_date: null,
  project_ids: [],
  project_count: 0,
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  points: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  project_health: { on_track: 0, at_risk: 0, off_track: 0, none: 0 },
  last_update_at: null,
  update_interval_days: 7,
  update_interval_inherited: true,
  next_update_due_at: null,
  update_due_state: null,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

/** The workspace member who owns things. */
const ada: MemberRead = {
  user_id: 'user-1',
  email: 'ada@example.com',
  display_name: 'Ada Lovelace',
  role: 'admin',
  joined_at: '2026-09-17T00:00:00Z',
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
    <MemoryRouter initialEntries={['/w/mine/initiatives']}>
      <Routes>
        <Route path="/w/:slug/initiatives" element={<Initiatives />} />
        <Route
          path="/w/:slug/initiatives/:id"
          element={<p>initiative page</p>}
        />
      </Routes>
    </MemoryRouter>
  );

describe('Initiatives', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listMembers.mockResolvedValue([ada]);
    listInitiatives.mockResolvedValue({ initiatives: [], next_cursor: null });
  });

  it('groups initiatives by status with their projects and progress', async () => {
    listInitiatives.mockResolvedValue({
      initiatives: [
        initiative('ini-1', 'Grow', {
          status: 'active',
          owner_id: 'user-1',
          project_ids: ['prj-1', 'prj-2'],
          project_count: 2,
          counts: { todo: 1, in_progress: 0, done: 3, cancelled: 0, total: 4 },
        }),
        initiative('ini-2', 'Expand'),
      ],
      next_cursor: null,
    });
    renderPage();

    const active = await screen.findByRole('region', { name: 'Active' });
    expect(within(active).getByRole('link', { name: 'Grow' })).toHaveAttribute(
      'href',
      '/w/mine/initiatives/ini-1'
    );
    expect(within(active).getByText('2 projects')).toBeInTheDocument();
    expect(within(active).getByText('75%')).toBeInTheDocument();
    expect(
      await within(active).findByText('Owner Ada Lovelace')
    ).toBeInTheDocument();
    const planned = screen.getByRole('region', { name: 'Planned' });
    expect(within(planned).getByText('Expand')).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Completed' })
    ).not.toBeInTheDocument();
  });

  it('creates an initiative owned by the creator and opens it', async () => {
    createInitiative.mockResolvedValue(initiative('ini-9', 'Launch'));
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'New initiative' })
    );
    await user.type(screen.getByLabelText('Initiative name'), 'Launch');
    await user.type(screen.getByLabelText('Summary'), 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Create initiative' }));

    await waitFor(() => {
      expect(createInitiative).toHaveBeenCalledWith({
        name: 'Launch',
        description: 'Ship it',
        owner_id: 'user-1',
        status: 'planned',
        target_date: null,
      });
    });
    expect(await screen.findByText('initiative page')).toBeInTheDocument();
  });

  it('explains initiatives when there are none', async () => {
    renderPage();

    expect(await screen.findByText(/No initiatives yet/)).toBeInTheDocument();
  });

  it('keeps guests out', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    renderPage();

    expect(
      await screen.findByText(
        'Initiatives are open to workspace members, not guests.'
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New initiative' })
    ).not.toBeInTheDocument();
    expect(listInitiatives).not.toHaveBeenCalled();
  });
});
