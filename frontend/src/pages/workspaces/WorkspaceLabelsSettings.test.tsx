/**
 * The workspace Labels settings page: labels every team inherits. An admin
 * adds, recolors, renames and deletes them behind a confirmation, and a
 * member sees the list with nothing to edit.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  LabelCreate,
  LabelRead,
  LabelUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import WorkspaceLabelsSettings from './WorkspaceLabelsSettings';

const listWorkspaceLabels = vi.fn<() => Promise<LabelRead[]>>();
const createWorkspaceLabel = vi.fn<(body: LabelCreate) => Promise<LabelRead>>();
const updateWorkspaceLabel =
  vi.fn<(labelId: string, body: LabelUpdate) => Promise<LabelRead>>();
const deleteWorkspaceLabel = vi.fn<(labelId: string) => Promise<void>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../api/workflow', () => ({
  listWorkspaceLabels: () => listWorkspaceLabels(),
  createWorkspaceLabel: (_w: string, body: LabelCreate) =>
    createWorkspaceLabel(body),
  updateWorkspaceLabel: (_w: string, id: string, body: LabelUpdate) =>
    updateWorkspaceLabel(id, body),
  deleteWorkspaceLabel: (_w: string, id: string) => deleteWorkspaceLabel(id),
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

const rows: LabelRead[] = [
  { id: 'security', name: 'Security', color: '#8b5cd6' },
  { id: 'bug', name: 'Bug', color: '#e5484d' },
];

beforeEach(() => {
  listWorkspaceLabels.mockReset();
  createWorkspaceLabel.mockReset();
  updateWorkspaceLabel.mockReset();
  deleteWorkspaceLabel.mockReset();
  listTeams.mockReset();
  listTeams.mockResolvedValue([]);
  listWorkspaceLabels.mockResolvedValue(rows);
  createWorkspaceLabel.mockImplementation((body) =>
    Promise.resolve({ id: 'new', ...body })
  );
  updateWorkspaceLabel.mockResolvedValue(rows[0]!);
  deleteWorkspaceLabel.mockResolvedValue(undefined);
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/settings/labels']}>
      <WorkspaceLabelsSettings />
    </MemoryRouter>
  );

describe('the workspace labels page', () => {
  it('lists the labels in name order and links from the settings tabs', async () => {
    renderPage();
    const bug = await screen.findByDisplayValue('Bug');
    const security = screen.getByDisplayValue('Security');
    expect(
      bug.compareDocumentPosition(security) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Labels' })).toHaveAttribute(
      'href',
      '/w/mine/settings/labels'
    );
  });

  it('adds a label', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('New label'), 'Customer');
    await user.click(screen.getByRole('button', { name: 'Add label' }));
    await waitFor(() => {
      expect(createWorkspaceLabel).toHaveBeenCalledWith({
        name: 'Customer',
        color: '#3b7cf0',
      });
    });
  });

  it('recolors a label from the palette', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Change the color of Bug' })
    );
    await user.click(screen.getByRole('radio', { name: 'Orange' }));
    await waitFor(() => {
      expect(updateWorkspaceLabel).toHaveBeenCalledWith('bug', {
        color: '#f0712c',
      });
    });
  });

  it('asks before deleting a label from every team', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Bug' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Bug?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteWorkspaceLabel).toHaveBeenCalledWith('bug');
    });
  });

  it('shows a member the labels with nothing to edit', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();
    expect(await screen.findByText('Security')).toBeInTheDocument();
    expect(screen.queryByLabelText('New label')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Bug' })
    ).not.toBeInTheDocument();
  });
});
