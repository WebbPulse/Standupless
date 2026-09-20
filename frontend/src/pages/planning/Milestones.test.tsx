/**
 * The milestones page. Covers that a milestone's status is written rather than
 * derived, which is the one thing that distinguishes this page from the cycles
 * one, and the same read, filter and role boundaries.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  MilestoneCreate,
  MilestoneListRead,
  MilestoneRead,
  ProjectRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Milestones from './Milestones';

const listMilestones = vi.fn<(query: unknown) => Promise<MilestoneListRead>>();
const createMilestone =
  vi.fn<(body: MilestoneCreate) => Promise<MilestoneRead>>();
const updateMilestone =
  vi.fn<(id: string, body: unknown) => Promise<MilestoneRead>>();
const deleteMilestone = vi.fn<(id: string) => Promise<void>>();
const listProjects = vi.fn<() => Promise<ProjectRead[]>>();

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
  listMilestones: (_w: string, query: unknown) => listMilestones(query),
  createMilestone: (_w: string, body: MilestoneCreate) => createMilestone(body),
  updateMilestone: (_w: string, id: string, body: unknown) =>
    updateMilestone(id, body),
  deleteMilestone: (_w: string, id: string) => deleteMilestone(id),
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

const milestone: MilestoneRead = {
  milestone_id: 'mil-1',
  workspace_id: 'ws-1',
  project_id: 'proj-1',
  name: 'Public beta',
  description: null,
  target_date: '2026-10-01',
  status: 'planned',
  counts: { todo: 2, in_progress: 0, done: 1, cancelled: 0, total: 3 },
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
    <MemoryRouter initialEntries={['/w/mine/p/ENG/milestones']}>
      <Routes>
        <Route
          path="/w/:slug/p/:keyPrefix/milestones"
          element={<Milestones />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listMilestones.mockReset();
  createMilestone.mockReset();
  updateMilestone.mockReset();
  deleteMilestone.mockReset();
  listProjects.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  listProjects.mockResolvedValue([project]);
  listMilestones.mockResolvedValue({
    milestones: [milestone],
    next_cursor: null,
  });
  createMilestone.mockResolvedValue(milestone);
  updateMilestone.mockResolvedValue(milestone);
  deleteMilestone.mockResolvedValue(undefined);
});

describe('reading the list', () => {
  it('reads under the project the route names', async () => {
    renderPage();

    await waitFor(() => {
      expect(listMilestones).toHaveBeenCalledWith({ project_id: 'proj-1' });
    });
  });

  it('draws the milestone with its target date and its counts', async () => {
    renderPage();

    expect(await screen.findByText('Public beta')).toBeInTheDocument();
    expect(screen.getByText('2026-10-01')).toBeInTheDocument();
    expect(screen.getByText(/3 issues/)).toBeInTheDocument();
  });

  it('names the absence of a target date rather than drawing nothing', async () => {
    listMilestones.mockResolvedValue({
      milestones: [{ ...milestone, target_date: null }],
      next_cursor: null,
    });

    renderPage();

    expect(await screen.findByText('No target date')).toBeInTheDocument();
  });

  it('says so when the project has no milestones yet', async () => {
    listMilestones.mockResolvedValue({ milestones: [], next_cursor: null });

    renderPage();

    expect(await screen.findByText('No milestones yet.')).toBeInTheDocument();
  });

  it('re-reads under the status filter rather than hiding rows on screen', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.selectOptions(screen.getByLabelText('Status'), 'done');

    await waitFor(() => {
      expect(listMilestones).toHaveBeenCalledWith({
        project_id: 'proj-1',
        status: 'done',
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
  it('creates without a target date when none was given', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.type(screen.getByLabelText('New milestone'), 'GA');
    await userEvent.click(
      screen.getByRole('button', { name: 'Create milestone' })
    );

    await waitFor(() => {
      expect(createMilestone).toHaveBeenCalled();
    });
    const body = createMilestone.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('target_date');
    expect(body?.name).toBe('GA');
    expect(body?.project_id).toBe('proj-1');
  });

  it('refuses to create without a name', async () => {
    renderPage();
    await screen.findByText('Public beta');

    expect(
      screen.getByRole('button', { name: 'Create milestone' })
    ).toBeDisabled();
  });

  it('writes a status directly, unlike a cycle whose status is derived', async () => {
    renderPage();
    await screen.findByText('Public beta');

    await userEvent.selectOptions(
      screen.getByLabelText('Status of Public beta'),
      'in_progress'
    );

    await waitFor(() => {
      expect(updateMilestone).toHaveBeenCalledWith('mil-1', {
        project_id: 'proj-1',
        status: 'in_progress',
      });
    });
  });

  it('deletes as an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));

    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Delete Public beta' })
    );

    await waitFor(() => {
      expect(deleteMilestone).toHaveBeenCalledWith('mil-1');
    });
  });
});

describe('what a role is offered', () => {
  it('draws no create form and locks the status for a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...roleless } = project;
    listProjects.mockResolvedValue([roleless]);

    renderPage();
    await screen.findByText('Public beta');

    expect(screen.queryByLabelText('New milestone')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status of Public beta')).toBeDisabled();
  });

  it('draws no delete control for a plain member', async () => {
    renderPage();
    await screen.findByText('Public beta');

    expect(
      screen.queryByRole('button', { name: 'Delete Public beta' })
    ).not.toBeInTheDocument();
  });
});
