/**
 * The roadmap. Covers that it draws each dated project as a bar over its
 * dates, lists an undated one without a bar, narrows to a team from the URL,
 * moves a bar a day with the arrow keys and writes the new dates, and switches
 * zoom levels.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectListRead,
  ProjectRead,
  ProjectUpdate,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Roadmap from './Roadmap';

const listProjects =
  vi.fn<
    (query: { team_id?: string; cursor?: string }) => Promise<ProjectListRead>
  >();
const updateProject =
  vi.fn<(id: string, patch: ProjectUpdate) => Promise<ProjectRead>>();
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
  listProjects: (_w: string, query: { team_id?: string; cursor?: string }) =>
    listProjects(query),
  updateProject: (_w: string, id: string, patch: ProjectUpdate) =>
    updateProject(id, patch),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listTeamMembers: () => Promise.resolve([]),
  listStatuses: () => Promise.resolve([]),
  listLabels: () => Promise.resolve([]),
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

/** The team most rows belong to. */
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

/** A second team, so the fan-out and the team filter have something to do. */
const design: TeamRead = {
  ...engine,
  id: 'team-2',
  name: 'Design',
  key_prefix: 'DES',
};

/** One project as the planning route answers it. */
const launch: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_ids: ['team-1'],
  lead_id: null,
  start_date: '2026-09-20',
  name: 'Launch',
  description: null,
  target_date: '2026-10-01',
  status: 'in_progress',
  counts: { todo: 1, in_progress: 1, done: 2, cancelled: 0, total: 4 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** A project on the other team with no dates yet. */
const rebrand: ProjectRead = {
  ...launch,
  project_id: 'prj-2',
  team_id: 'team-2',
  name: 'Rebrand',
  start_date: null,
  target_date: null,
  status: 'planned',
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

const renderPage = (entry = '/w/mine/roadmap') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/w/:slug/roadmap" element={<Roadmap />} />
        <Route path="/w/:slug/projects/:id" element={<p>project page</p>} />
      </Routes>
    </MemoryRouter>
  );

describe('Roadmap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    listTeams.mockResolvedValue([engine, design]);
    listProjects.mockResolvedValue({
      projects: [launch, rebrand],
      next_cursor: null,
    });
  });

  it('draws a dated project as a bar over its dates', async () => {
    renderPage();

    expect(
      await screen.findByRole('slider', {
        name: 'Launch, 2026-09-20 to 2026-10-01',
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Launch' })).toHaveAttribute(
      'href',
      '/w/mine/projects/prj-1'
    );
  });

  it('lists an undated project without a bar', async () => {
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Rebrand' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: /^Rebrand/ })).toBeNull();
  });

  it('says so when there is nothing to plan', async () => {
    listProjects.mockResolvedValue({ projects: [], next_cursor: null });
    renderPage();

    expect(
      await screen.findByText(/No projects to plan yet/)
    ).toBeInTheDocument();
  });

  it('narrows to the team in the URL', async () => {
    renderPage('/w/mine/roadmap?team=DES');

    await waitFor(() => {
      expect(listProjects).toHaveBeenCalledWith({ team_id: 'team-2' });
    });
  });

  it('moves a bar a day with the arrow keys', async () => {
    updateProject.mockImplementation((_id, patch) =>
      Promise.resolve({ ...launch, ...patch })
    );
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        start_date: '2026-09-21',
        target_date: '2026-10-02',
      });
    });
  });

  it('moves the end alone with shift', async () => {
    updateProject.mockImplementation((_id, patch) =>
      Promise.resolve({ ...launch, ...patch })
    );
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });

    await waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith('prj-1', {
        start_date: '2026-09-20',
        target_date: '2026-10-02',
      });
    });
  });

  it('does not move a bar for a role that may not write', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    listTeams.mockResolvedValue(
      [
        { ...engine, role: 'member' },
        { ...design, role: 'member' },
      ].map(({ role: _role, ...rest }) => rest)
    );
    renderPage();

    const bar = await screen.findByRole('slider', { name: /^Launch/ });
    fireEvent.keyDown(bar, { key: 'ArrowRight' });

    expect(bar).toHaveAttribute('aria-readonly', 'true');
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('switches the zoom level', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Launch' });
    expect(screen.getByRole('radio', { name: 'Months' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    await user.click(screen.getByRole('radio', { name: 'Weeks' }));
    expect(screen.getByRole('radio', { name: 'Weeks' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
