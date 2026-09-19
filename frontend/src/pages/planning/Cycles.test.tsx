/**
 * The cycles page. Covers that the list is read under the project the route
 * names, that the status filter restarts the read rather than filtering rows
 * already on screen, that creating sends no status because the server derives
 * it, and that the controls a role may not use are not drawn.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CycleCreate,
  CycleListRead,
  CycleRead,
  ProjectRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Cycles from './Cycles';

const listCycles = vi.fn<(query: unknown) => Promise<CycleListRead>>();
const createCycle = vi.fn<(body: CycleCreate) => Promise<CycleRead>>();
const updateCycle = vi.fn<(id: string, body: unknown) => Promise<CycleRead>>();
const deleteCycle = vi.fn<(id: string) => Promise<void>>();
const listProjects = vi.fn<() => Promise<ProjectRead[]>>();

vi.mock('../../api/planning', () => ({
  listCycles: (_w: string, query: unknown) => listCycles(query),
  createCycle: (_w: string, body: CycleCreate) => createCycle(body),
  updateCycle: (_w: string, id: string, body: unknown) => updateCycle(id, body),
  deleteCycle: (_w: string, id: string) => deleteCycle(id),
}));

vi.mock('../../api/projects', () => ({
  listProjects: () => listProjects(),
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

const project: ProjectRead = {
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
  project_id: 'proj-1',
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
    <MemoryRouter initialEntries={['/w/mine/p/ENG/cycles']}>
      <Routes>
        <Route path="/w/:slug/p/:keyPrefix/cycles" element={<Cycles />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listCycles.mockReset();
  createCycle.mockReset();
  updateCycle.mockReset();
  deleteCycle.mockReset();
  listProjects.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  listProjects.mockResolvedValue([project]);
  listCycles.mockResolvedValue({ cycles: [cycle], next_cursor: null });
  createCycle.mockResolvedValue(cycle);
  updateCycle.mockResolvedValue(cycle);
  deleteCycle.mockResolvedValue(undefined);
});

describe('reading the list', () => {
  it('reads under the project the route names', async () => {
    renderPage();

    await waitFor(() => {
      expect(listCycles).toHaveBeenCalledWith({ project_id: 'proj-1' });
    });
  });

  it('draws the cycle with its derived status and its counts', async () => {
    renderPage();

    expect(await screen.findByText('Sprint 1')).toBeInTheDocument();
    expect(
      screen.getByText(/Active · 2026-09-01 to 2026-09-14/)
    ).toBeInTheDocument();
    expect(screen.getByText(/4 issues/)).toBeInTheDocument();
  });

  it('says so when the project has no cycles yet', async () => {
    listCycles.mockResolvedValue({ cycles: [], next_cursor: null });

    renderPage();

    expect(await screen.findByText('No cycles yet.')).toBeInTheDocument();
  });

  it('re-reads under the status filter rather than hiding rows on screen', async () => {
    renderPage();
    await screen.findByText('Sprint 1');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'completed');

    await waitFor(() => {
      expect(listCycles).toHaveBeenCalledWith({
        project_id: 'proj-1',
        status: 'completed',
      });
    });
  });

  it('shows the project is invisible rather than an empty list', async () => {
    listProjects.mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(
        'That project does not exist, or you are not a member of it.'
      )
    ).toBeInTheDocument();
  });
});

describe('writing', () => {
  it('creates without a status, which the server derives from the dates', async () => {
    renderPage();
    await screen.findByText('Sprint 1');

    await userEvent.type(screen.getByLabelText('New cycle'), 'Sprint 2');
    await userEvent.type(screen.getByLabelText('Start date'), '2026-09-15');
    await userEvent.type(screen.getByLabelText('End date'), '2026-09-28');
    await userEvent.click(screen.getByRole('button', { name: 'Create cycle' }));

    await waitFor(() => {
      expect(createCycle).toHaveBeenCalled();
    });
    const body = createCycle.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('status');
    expect(body?.project_id).toBe('proj-1');
    expect(body?.name).toBe('Sprint 2');
  });

  it('refuses to create until both dates are set', async () => {
    renderPage();
    await screen.findByText('Sprint 1');

    await userEvent.type(screen.getByLabelText('New cycle'), 'Sprint 2');

    expect(screen.getByRole('button', { name: 'Create cycle' })).toBeDisabled();
  });

  it('refuses an end date before the start date', async () => {
    renderPage();
    await screen.findByText('Sprint 1');

    await userEvent.type(screen.getByLabelText('New cycle'), 'Sprint 2');
    await userEvent.type(screen.getByLabelText('Start date'), '2026-09-28');
    await userEvent.type(screen.getByLabelText('End date'), '2026-09-15');

    expect(
      await screen.findByText('The end date cannot fall before the start date.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create cycle' })).toBeDisabled();
  });

  it('cancels a cycle through the project that names the row', async () => {
    renderPage();
    await screen.findByText('Sprint 1');

    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel Sprint 1' })
    );

    await waitFor(() => {
      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        project_id: 'proj-1',
        cancelled: true,
      });
    });
  });

  it('offers to restore a cycle that was cancelled', async () => {
    listCycles.mockResolvedValue({
      cycles: [{ ...cycle, cancelled: true, status: 'cancelled' }],
      next_cursor: null,
    });

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Restore Sprint 1' })
    );

    await waitFor(() => {
      expect(updateCycle).toHaveBeenCalledWith('cyc-1', {
        project_id: 'proj-1',
        cancelled: false,
      });
    });
  });

  it('deletes as an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete Sprint 1' })
    );

    await waitFor(() => {
      expect(deleteCycle).toHaveBeenCalledWith('cyc-1');
    });
  });
});

describe('what a role is offered', () => {
  it('draws no create form or cancel control for a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...roleless } = project;
    listProjects.mockResolvedValue([roleless]);

    renderPage();
    await screen.findByText('Sprint 1');

    expect(screen.queryByLabelText('New cycle')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel Sprint 1' })
    ).not.toBeInTheDocument();
  });

  it('draws no delete control for a plain member', async () => {
    renderPage();
    await screen.findByText('Sprint 1');

    expect(
      screen.queryByRole('button', { name: 'Delete Sprint 1' })
    ).not.toBeInTheDocument();
  });
});
