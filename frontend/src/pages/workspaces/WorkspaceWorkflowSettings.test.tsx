/**
 * The workspace Workflow settings page: statuses every team inherits, grouped
 * by category. An admin adds, recolors, reorders and deletes them behind a
 * confirmation, the refusal a delete can meet reads in the server's words,
 * and a member sees the list with nothing to edit.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  StatusCreate,
  StatusRead,
  StatusUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import WorkspaceWorkflowSettings from './WorkspaceWorkflowSettings';

const listWorkspaceStatuses = vi.fn<() => Promise<StatusRead[]>>();
const createWorkspaceStatus =
  vi.fn<(body: StatusCreate) => Promise<StatusRead>>();
const updateWorkspaceStatus =
  vi.fn<(statusId: string, body: StatusUpdate) => Promise<StatusRead>>();
const deleteWorkspaceStatus = vi.fn<(statusId: string) => Promise<void>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../api/workflow', () => ({
  listWorkspaceStatuses: () => listWorkspaceStatuses(),
  createWorkspaceStatus: (_w: string, body: StatusCreate) =>
    createWorkspaceStatus(body),
  updateWorkspaceStatus: (_w: string, id: string, body: StatusUpdate) =>
    updateWorkspaceStatus(id, body),
  deleteWorkspaceStatus: (_w: string, id: string) => deleteWorkspaceStatus(id),
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

const rows: StatusRead[] = [
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'doing', name: 'In Progress', category: 'started', position: 1 },
  { id: 'review', name: 'In Review', category: 'started', position: 2 },
  { id: 'done', name: 'Done', category: 'completed', position: 3 },
];

beforeEach(() => {
  listWorkspaceStatuses.mockReset();
  createWorkspaceStatus.mockReset();
  updateWorkspaceStatus.mockReset();
  deleteWorkspaceStatus.mockReset();
  listTeams.mockReset();
  listTeams.mockResolvedValue([]);
  listWorkspaceStatuses.mockResolvedValue(rows);
  createWorkspaceStatus.mockImplementation((body) =>
    Promise.resolve({ id: 'new', position: 4, ...body })
  );
  updateWorkspaceStatus.mockResolvedValue(rows[0]!);
  deleteWorkspaceStatus.mockResolvedValue(undefined);
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/settings/workflow']}>
      <WorkspaceWorkflowSettings />
    </MemoryRouter>
  );

describe('the workspace workflow page', () => {
  it('groups the statuses by category and links from the settings tabs', async () => {
    renderPage();
    const started = await screen.findByRole('region', { name: 'Started' });
    expect(within(started).getByDisplayValue('In Progress')).toBeVisible();
    expect(within(started).getByDisplayValue('In Review')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Workflow' })).toHaveAttribute(
      'href',
      '/w/mine/settings/workflow'
    );
  });

  it('adds a status to a category', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Add status to Backlog' })
    );
    await user.type(screen.getByLabelText('New status'), 'Icebox');
    await user.click(screen.getByRole('button', { name: 'Add status' }));
    await waitFor(() => {
      expect(createWorkspaceStatus).toHaveBeenCalledWith({
        name: 'Icebox',
        category: 'backlog',
        position: 4,
      });
    });
  });

  it('recolors a status with the shared picker', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', {
        name: 'Change the color and icon of Done',
      })
    );
    await user.click(screen.getByRole('radio', { name: 'Green' }));
    await waitFor(() => {
      expect(updateWorkspaceStatus).toHaveBeenCalledWith('done', {
        color: 'green',
      });
    });
  });

  it('swaps positions within a category', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Move In Review up' })
    );
    await waitFor(() => {
      expect(updateWorkspaceStatus).toHaveBeenCalledWith('review', {
        position: 1,
      });
    });
    expect(updateWorkspaceStatus).toHaveBeenCalledWith('doing', {
      position: 2,
    });
    expect(
      screen.getByRole('button', { name: 'Move In Progress up' })
    ).toBeDisabled();
  });

  it('asks before a delete and shows the refusal in the server words', async () => {
    deleteWorkspaceStatus.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: {
          error_code: 'LAST_VISIBLE',
          message:
            'A team must keep one visible status in each category it uses',
        },
        url: '/api/workspaces/ws-1/statuses/done',
        method: 'DELETE',
      })
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Done' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Done?' });
    expect(deleteWorkspaceStatus).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(deleteWorkspaceStatus).toHaveBeenCalledWith('done');
    expect(
      await screen.findByText(
        'A team must keep one visible status in each category it uses'
      )
    ).toBeInTheDocument();
  });

  it('shows a member the statuses with nothing to edit', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();
    expect(await screen.findByText('In Progress')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add status to Backlog' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Done' })
    ).not.toBeInTheDocument();
  });
});
