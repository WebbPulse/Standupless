/**
 * The workspace Project statuses page: statuses grouped by their fixed
 * category. An admin adds, recolors, renames, reorders and deletes them, a
 * delete moving the status's projects onto a chosen replacement, and a member
 * sees the list with nothing to edit.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ProjectStatus,
  ProjectStatusCreate,
  ProjectStatusRead,
  ProjectStatusUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import ProjectStatusesSettings from './ProjectStatusesSettings';

const listProjectStatuses = vi.fn<() => Promise<ProjectStatusRead[]>>();
const createProjectStatus =
  vi.fn<(body: ProjectStatusCreate) => Promise<ProjectStatusRead>>();
const updateProjectStatus =
  vi.fn<
    (statusId: string, body: ProjectStatusUpdate) => Promise<ProjectStatusRead>
  >();
const deleteProjectStatus =
  vi.fn<(statusId: string, replacementId?: string) => Promise<void>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../api/projectStatuses', () => ({
  projectStatusesPath: (workspaceId: string) =>
    `/workspaces/${workspaceId}/project-statuses`,
  listProjectStatuses: () => listProjectStatuses(),
  createProjectStatus: (_w: string, body: ProjectStatusCreate) =>
    createProjectStatus(body),
  updateProjectStatus: (_w: string, id: string, body: ProjectStatusUpdate) =>
    updateProjectStatus(id, body),
  deleteProjectStatus: (_w: string, id: string, replacementId?: string) =>
    deleteProjectStatus(id, replacementId),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
}));

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

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => ({
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
});

/** One status row as the API answers it. */
const status = (
  id: string,
  name: string,
  category: ProjectStatus,
  position: number,
  projectCount = 0
): ProjectStatusRead => ({
  id,
  name,
  category,
  color: null,
  description: null,
  position,
  is_default: position === 0,
  project_count: projectCount,
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
});

const rows: ProjectStatusRead[] = [
  status('backlog', 'Backlog', 'backlog', 0),
  status('planned', 'Planned', 'planned', 0),
  status('in_progress', 'In progress', 'in_progress', 0, 2),
  status('01M5RQRD9EZAVVYR95D2YSSTS2', 'In review', 'in_progress', 1, 3),
  status('paused', 'Paused', 'paused', 0),
  status('completed', 'Completed', 'completed', 0),
  status('canceled', 'Canceled', 'canceled', 0),
];

beforeEach(() => {
  listProjectStatuses.mockReset();
  createProjectStatus.mockReset();
  updateProjectStatus.mockReset();
  deleteProjectStatus.mockReset();
  listTeams.mockReset();
  listTeams.mockResolvedValue([]);
  listProjectStatuses.mockResolvedValue(rows);
  createProjectStatus.mockImplementation((body) =>
    Promise.resolve(status('new', body.name, body.category, 2))
  );
  updateProjectStatus.mockResolvedValue(rows[3]!);
  deleteProjectStatus.mockResolvedValue(undefined);
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/settings/project-statuses']}>
      <ProjectStatusesSettings />
    </MemoryRouter>
  );

describe('the project statuses page', () => {
  it('groups the statuses by category', async () => {
    renderPage();
    const started = await screen.findByRole('region', { name: 'In progress' });
    expect(within(started).getByDisplayValue('In review')).toBeInTheDocument();
    expect(within(started).getByText('3 projects')).toBeInTheDocument();
  });

  it('adds a status to a category', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Add a paused status' })
    );
    await user.type(screen.getByLabelText('New paused status'), 'Blocked');
    await user.click(screen.getByRole('button', { name: 'Add status' }));
    await waitFor(() => {
      expect(createProjectStatus).toHaveBeenCalledWith({
        name: 'Blocked',
        category: 'paused',
        color: '#8b919c',
      });
    });
  });

  it('moves a status up within its category', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for In review' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => {
      expect(updateProjectStatus).toHaveBeenCalledWith(
        '01M5RQRD9EZAVVYR95D2YSSTS2',
        { position: 0 }
      );
    });
  });

  it('asks for a replacement before deleting a status', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for In review' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete In review?',
    });
    expect(within(dialog).getByLabelText('Move projects to')).toHaveValue(
      'in_progress'
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteProjectStatus).toHaveBeenCalledWith(
        '01M5RQRD9EZAVVYR95D2YSSTS2',
        'in_progress'
      );
    });
  });

  it('keeps the last status of a category', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Paused' })
    );
    expect(
      screen.getByRole('menuitem', { name: 'Delete (last in its category)' })
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows a member the statuses with nothing to edit', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();
    expect(await screen.findByText('In review')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for In review' })
    ).not.toBeInTheDocument();
  });
});
