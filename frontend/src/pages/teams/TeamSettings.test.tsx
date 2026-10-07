/**
 * The team settings route: the General section's rename and typed-confirm
 * delete, and the status, label and team member sections, including the
 * reorder that the contract makes two position PATCHes because it exposes no
 * bulk route, and the pull request labels switch.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  LabelRead,
  MemberRead,
  TeamMemberRead,
  TeamRead,
  StatusRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import TeamSettings from './TeamSettings';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const createStatus = vi.fn<(body: unknown) => Promise<StatusRead>>();
const updateStatus =
  vi.fn<(statusId: string, body: unknown) => Promise<StatusRead>>();
const deleteStatus =
  vi.fn<(statusId: string, replacementId?: string) => Promise<void>>();
const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const createLabel = vi.fn<(body: unknown) => Promise<LabelRead>>();
const updateLabel =
  vi.fn<(labelId: string, body: unknown) => Promise<LabelRead>>();
const deleteLabel = vi.fn<(labelId: string) => Promise<void>>();
const listTeamMembers = vi.fn<() => Promise<TeamMemberRead[]>>();
const setTeamMember =
  vi.fn<(userId: string, body: unknown) => Promise<TeamMemberRead>>();
const removeTeamMember = vi.fn<(userId: string) => Promise<void>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const updateTeam = vi.fn<(body: unknown) => Promise<TeamRead>>();
const deleteTeam = vi.fn<() => Promise<void>>();
const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
});

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

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  updateTeam: (_w: string, _t: string, body: unknown) => updateTeam(body),
  deleteTeam: () => deleteTeam(),
  listStatuses: () => listStatuses(),
  createStatus: (_w: string, _p: string, body: unknown) => createStatus(body),
  updateStatus: (_w: string, _p: string, statusId: string, body: unknown) =>
    updateStatus(statusId, body),
  deleteStatus: (
    _w: string,
    _p: string,
    statusId: string,
    replacementId?: string
  ) => deleteStatus(statusId, replacementId),
  listLabels: () => listLabels(),
  createLabel: (_w: string, _p: string, body: unknown) => createLabel(body),
  updateLabel: (_w: string, _p: string, labelId: string, body: unknown) =>
    updateLabel(labelId, body),
  deleteLabel: (_w: string, _p: string, labelId: string) =>
    deleteLabel(labelId),
  listTeamMembers: () => listTeamMembers(),
  setTeamMember: (_w: string, _p: string, userId: string, body: unknown) =>
    setTeamMember(userId, body),
  removeTeamMember: (_w: string, _p: string, userId: string) =>
    removeTeamMember(userId),
}));

vi.mock('../../api/workspaces', () => ({
  listMembers: () => listMembers(),
}));

vi.mock('../../api/releases', () => ({
  getReleasePipeline: () =>
    Promise.resolve({
      team_id: 'proj-1',
      configured: false,
      stages: [
        { stage_id: 'production', name: 'Production', github_environments: [] },
      ],
    }),
  updateReleasePipeline: vi.fn(),
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

/** One team row as the team list route answers it. */
const team: TeamRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** The first status, which the write spies answer with when the body is ignored. */
const todo: StatusRead = {
  id: 'st-1',
  name: 'Todo',
  category: 'unstarted',
  position: 0,
};

/** Two statuses in position order, which is how the list route returns them. */
const statuses: StatusRead[] = [
  todo,
  { id: 'st-2', name: 'Doing', category: 'started', position: 1 },
];

/** One label row as the list route answers it. */
const label: LabelRead = { id: 'lb-1', name: 'bug', color: '#ef4444' };

/** One team member row as the list route answers it. */
const teamMember: TeamMemberRead = {
  user_id: 'user-2',
  email: 'other@example.com',
  display_name: 'Other',
  role: 'member',
  added_at: '2026-09-17T00:00:00Z',
};

/** A resolved workspace context with the caller holding `role`. */
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

/** Mounts the team settings route with `keyPrefix` in the path. */
const renderPage = (keyPrefix = 'ENG') =>
  render(
    <MemoryRouter initialEntries={[`/w/mine/team/${keyPrefix}/settings`]}>
      <Routes>
        <Route
          path="/w/:slug/team/:keyPrefix/settings"
          element={<TeamSettings />}
        />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  for (const spy of [
    listTeams,
    listStatuses,
    createStatus,
    updateStatus,
    deleteStatus,
    listLabels,
    createLabel,
    updateLabel,
    deleteLabel,
    listTeamMembers,
    setTeamMember,
    removeTeamMember,
    listMembers,
    updateTeam,
    deleteTeam,
    navigate,
  ]) {
    spy.mockReset();
  }
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
  listTeams.mockResolvedValue([team]);
  listStatuses.mockResolvedValue(statuses);
  listLabels.mockResolvedValue([label]);
  listTeamMembers.mockResolvedValue([teamMember]);
  listMembers.mockResolvedValue([]);
});

describe('the general section', () => {
  it('renames the team and leaves the key read only', async () => {
    updateTeam.mockResolvedValue({ ...team, name: 'Platform' });
    const user = userEvent.setup();
    renderPage();

    const name = await screen.findByLabelText('Name', {
      selector: '#team-general-name',
    });
    expect(screen.getByLabelText('Key')).toHaveAttribute('readonly');
    await user.clear(name);
    await user.type(name, 'Platform');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({
        name: 'Platform',
        description: null,
        estimate_scale: 'off',
        estimate_extended: false,
        estimate_allow_zero: false,
        estimate_count_unestimated: false,
      });
    });
  });

  it('deletes only once the key is typed, then returns to the team list', async () => {
    deleteTeam.mockResolvedValue();
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Delete team' })
    );
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete team' });
    expect(confirm).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText('Type ENG to confirm'),
      'eng'
    );
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => {
      expect(deleteTeam).toHaveBeenCalled();
    });
    expect(navigate).toHaveBeenCalledWith('/w/mine/settings/teams');
  });

  it('offers delete only to a workspace owner or admin, as the route checks', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      await screen.findByLabelText('Name', { selector: '#team-general-name' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete team' })
    ).not.toBeInTheDocument();
  });
});

describe('the status section', () => {
  it('groups the statuses by category', async () => {
    renderPage();

    const unstarted = await screen.findByRole('region', { name: 'Unstarted' });
    expect(within(unstarted).getByLabelText('Name of Todo')).toHaveValue(
      'Todo'
    );
    const started = screen.getByRole('region', { name: 'Started' });
    expect(within(started).getByLabelText('Name of Doing')).toHaveValue(
      'Doing'
    );
  });

  it('adds a status to a category after the last one', async () => {
    createStatus.mockResolvedValue(todo);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Add status to Completed' })
    );
    await user.type(screen.getByLabelText('New status'), 'Done');
    await user.click(screen.getByRole('button', { name: 'Add status' }));

    await waitFor(() => {
      expect(createStatus).toHaveBeenCalledWith({
        name: 'Done',
        category: 'completed',
        position: 2,
      });
    });
  });

  it('renames a status on blur, and not when nothing changed', async () => {
    updateStatus.mockResolvedValue(todo);
    const user = userEvent.setup();
    renderPage();

    const field = await screen.findByLabelText('Name of Todo');
    await user.clear(field);
    await user.type(field, 'Backlog');
    await user.tab();

    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('st-1', { name: 'Backlog' });
    });

    updateStatus.mockClear();
    await user.click(screen.getByLabelText('Name of Doing'));
    await user.tab();

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('reorders within a category by swapping the two positions', async () => {
    listStatuses.mockResolvedValue([
      ...statuses,
      { id: 'st-3', name: 'Review', category: 'started', position: 2 },
    ]);
    updateStatus.mockResolvedValue(todo);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Move Review up' })
    );

    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('st-3', { position: 1 });
    });
    expect(updateStatus).toHaveBeenCalledWith('st-2', { position: 2 });
  });

  it('disables the move that would leave the category', async () => {
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Move Todo up' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move Doing down' })
    ).toBeDisabled();
  });

  it('explains the refusal to delete the last status of a category', async () => {
    deleteStatus.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: {
          error_code: 'LAST_OF_CATEGORY',
          message: 'A category must keep at least one status.',
        },
        url: '/api/workspaces/ws-1/teams/proj-1/statuses/st-1',
        method: 'DELETE',
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Todo' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Todo?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(
      await screen.findByText(/A category must keep at least one/)
    ).toBeInTheDocument();
  });

  it('moves the issues of a deleted status to the chosen one', async () => {
    deleteStatus.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Todo' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Todo?' });
    expect(deleteStatus).not.toHaveBeenCalled();
    const picker = within(dialog).getByLabelText('Move issues to');
    expect(picker).toHaveValue('st-2');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteStatus).toHaveBeenCalledWith('st-1', 'st-2');
    });
  });
});

describe('the label section', () => {
  it('adds a label with its colour', async () => {
    createLabel.mockResolvedValue(label);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('New label'), 'needs review');
    await user.click(screen.getByRole('button', { name: 'Add label' }));

    await waitFor(() => {
      expect(createLabel).toHaveBeenCalledWith({
        name: 'needs review',
        color: '#3b7cf0',
      });
    });
  });

  it('surfaces a failed label read', async () => {
    listLabels.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load the labels.')
    ).toBeInTheDocument();
  });

  it('renames a label on blur', async () => {
    updateLabel.mockResolvedValue(label);
    const user = userEvent.setup();
    renderPage();

    const field = await screen.findByLabelText('Name of bug');
    await user.clear(field);
    await user.type(field, 'defect');
    await user.tab();

    await waitFor(() => {
      expect(updateLabel).toHaveBeenCalledWith('lb-1', { name: 'defect' });
    });
  });
});

describe('the team member section', () => {
  it('lists the members holding a role directly', async () => {
    renderPage();

    expect(await screen.findByText('Other')).toBeInTheDocument();
  });

  it('changes a team role through the row select', async () => {
    setTeamMember.mockResolvedValue(teamMember);
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByLabelText('Team role for other@example.com'),
      'admin'
    );

    await waitFor(() => {
      expect(setTeamMember).toHaveBeenCalledWith('user-2', {
        role: 'admin',
      });
    });
  });

  it('adds a workspace member who holds no team role yet', async () => {
    listMembers.mockResolvedValue([
      {
        user_id: 'user-3',
        email: 'third@example.com',
        display_name: 'Third',
        role: 'member',
        joined_at: '2026-09-17T00:00:00Z',
      },
    ]);
    setTeamMember.mockResolvedValue(teamMember);
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByLabelText('Add a member'),
      'user-3'
    );
    await user.click(screen.getByRole('button', { name: 'Add to team' }));

    await waitFor(() => {
      expect(setTeamMember).toHaveBeenCalledWith('user-3', {
        role: 'member',
      });
    });
  });

  it('leaves out anyone who already holds a team role', async () => {
    listMembers.mockResolvedValue([
      {
        user_id: 'user-2',
        email: 'other@example.com',
        display_name: 'Other',
        role: 'member',
        joined_at: '2026-09-17T00:00:00Z',
      },
    ]);
    renderPage();

    await screen.findByText('Other');
    expect(screen.queryByLabelText('Add a member')).not.toBeInTheDocument();
  });
});

describe('the capability gates', () => {
  it('shows a workspace member with no team role the settings read only', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listTeams.mockResolvedValue([{ ...team, role: 'member' }]);
    renderPage();

    expect(await screen.findByText('Todo')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add status to Unstarted' })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New label')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add to team' })
    ).not.toBeInTheDocument();
  });

  it('lets a team admin edit even when the workspace role would not', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listTeams.mockResolvedValue([{ ...team, role: 'admin' }]);
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Add status to Unstarted' })
    ).toBeInTheDocument();
  });
});

describe('the pull request labels setting', () => {
  it('reads as on by default and turns off through the team update', async () => {
    updateTeam.mockResolvedValue({ ...team, sync_pr_labels: false });
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByLabelText(
      'Sync issue labels to linked pull requests'
    );
    expect(toggle).toBeChecked();
    await user.click(toggle);

    await waitFor(() => {
      expect(updateTeam).toHaveBeenCalledWith({ sync_pr_labels: false });
    });
  });
});
