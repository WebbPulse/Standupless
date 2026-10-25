/**
 * The Recently deleted page: it lists the team's trash with who deleted each
 * issue, restores one, and offers Delete permanently to team admins alone,
 * behind a confirmation.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type { IssueRead, TeamRead } from '../../types/Api';
import TeamTrash from './TeamTrash';

const api = vi.hoisted(() => ({
  listDeletedIssues: vi.fn(),
  restoreIssue: vi.fn(),
  deleteIssuePermanently: vi.fn(),
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
  role: 'admin',
};

const deleted: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Login fails on Safari',
  body: null,
  status_id: 'st-todo',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-2',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  deleted_at: '2026-10-20T00:00:00Z',
  deleted_by: 'user-2',
};

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

vi.mock('../../hooks/useTeam', () => ({
  useTeam: () => ({
    team,
    teams: [team],
    workspaceId: 'ws-1',
    isLoading: false,
    notFound: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const workspace: WorkspaceContextType = {
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'admin',
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
};

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => workspace,
}));

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [
    {
      user_id: 'user-2',
      email: 'ada@example.test',
      display_name: 'Ada',
      role: 'member',
      joined_at: '2026-09-17T00:00:00Z',
    },
  ],
}));

vi.mock('../../api/issues', () => api);

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock('../../components/workspace/TeamTabs', () => ({
  default: () => null,
}));

vi.mock('../../components/workspace/TeamTitle', () => ({
  default: () => null,
}));

/** Mounts the trash route of team ENG. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/trash']}>
      <Routes>
        <Route path="/w/:slug/team/:keyPrefix/trash" element={<TeamTrash />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  team.role = 'admin';
  api.listDeletedIssues.mockReset();
  api.restoreIssue.mockReset();
  api.deleteIssuePermanently.mockReset();
  api.listDeletedIssues.mockResolvedValue({
    issues: [deleted],
    retention_days: 30,
  });
  api.restoreIssue.mockResolvedValue({ ...deleted, deleted_at: null });
  api.deleteIssuePermanently.mockResolvedValue(undefined);
});

describe('TeamTrash', () => {
  it('lists each deleted issue with who deleted it and the retention', async () => {
    renderPage();

    expect(await screen.findByText('Login fails on Safari')).toBeInTheDocument();
    expect(screen.getByText(/Deleted by Ada/)).toBeInTheDocument();
    expect(screen.getByText(/stay here for 30 days/)).toBeInTheDocument();
    expect(api.listDeletedIssues).toHaveBeenCalledWith('ws-1', 'team-1');
  });

  it('shows an empty state when nothing is deleted', async () => {
    api.listDeletedIssues.mockResolvedValue({ issues: [], retention_days: 30 });
    renderPage();

    expect(await screen.findByText(/No deleted issues/)).toBeInTheDocument();
  });

  it('restores an issue', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore ENG-1' })
    );

    await waitFor(() => {
      expect(api.restoreIssue).toHaveBeenCalledWith('ws-1', 'iss-1');
    });
  });

  it('deletes permanently after a confirmation for an admin', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete ENG-1 permanently' })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete permanently?',
    });
    expect(api.deleteIssuePermanently).not.toHaveBeenCalled();
    fireEvent.click(
      Array.from(dialog.querySelectorAll('button')).find(
        (button) => button.textContent === 'Delete permanently'
      ) as HTMLButtonElement
    );

    await waitFor(() => {
      expect(api.deleteIssuePermanently).toHaveBeenCalledWith('ws-1', 'iss-1');
    });
  });

  it('offers a member Restore but not Delete permanently', async () => {
    team.role = 'member';
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Restore ENG-1' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete ENG-1 permanently' })
    ).not.toBeInTheDocument();
  });
});
