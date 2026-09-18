/**
 * The project page and its settings tab. Covers resolving the key prefix out of
 * the project list, the issues tab, and the status, label
 * and project member sections, including the reorder that the contract makes
 * two position PATCHes because it exposes no bulk route.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  IssueListRead,
  LabelRead,
  MemberRead,
  ProjectMemberRead,
  ProjectRead,
  StatusRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Project from './Project';

const listProjects = vi.fn<() => Promise<ProjectRead[]>>();
const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const createStatus = vi.fn<(body: unknown) => Promise<StatusRead>>();
const updateStatus =
  vi.fn<(statusId: string, body: unknown) => Promise<StatusRead>>();
const deleteStatus = vi.fn<(statusId: string) => Promise<void>>();
const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const createLabel = vi.fn<(body: unknown) => Promise<LabelRead>>();
const updateLabel =
  vi.fn<(labelId: string, body: unknown) => Promise<LabelRead>>();
const deleteLabel = vi.fn<(labelId: string) => Promise<void>>();
const listProjectMembers = vi.fn<() => Promise<ProjectMemberRead[]>>();
const setProjectMember =
  vi.fn<(userId: string, body: unknown) => Promise<ProjectMemberRead>>();
const removeProjectMember = vi.fn<(userId: string) => Promise<void>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();

vi.mock('../../api/issues', () => ({
  ME: 'me',
  listIssues: (_w: string, query: unknown) => listIssues(query),
  appendIssues: (held: unknown[], page: { issues: unknown[] }) => [
    ...held,
    ...page.issues,
  ],
}));

vi.mock('../../api/projects', () => ({
  listProjects: () => listProjects(),
  listStatuses: () => listStatuses(),
  createStatus: (_w: string, _p: string, body: unknown) => createStatus(body),
  updateStatus: (_w: string, _p: string, statusId: string, body: unknown) =>
    updateStatus(statusId, body),
  deleteStatus: (_w: string, _p: string, statusId: string) =>
    deleteStatus(statusId),
  listLabels: () => listLabels(),
  createLabel: (_w: string, _p: string, body: unknown) => createLabel(body),
  updateLabel: (_w: string, _p: string, labelId: string, body: unknown) =>
    updateLabel(labelId, body),
  deleteLabel: (_w: string, _p: string, labelId: string) =>
    deleteLabel(labelId),
  listProjectMembers: () => listProjectMembers(),
  setProjectMember: (_w: string, _p: string, userId: string, body: unknown) =>
    setProjectMember(userId, body),
  removeProjectMember: (_w: string, _p: string, userId: string) =>
    removeProjectMember(userId),
}));

vi.mock('../../api/workspaces', () => ({
  listMembers: () => listMembers(),
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

/** One project row as the list route answers it. */
const project: ProjectRead = {
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

/** One project member row as the list route answers it. */
const projectMember: ProjectMemberRead = {
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

/** Mounts the project route with `keyPrefix` in the path. */
const renderPage = (keyPrefix = 'ENG') =>
  render(
    <MemoryRouter initialEntries={[`/w/mine/p/${keyPrefix}`]}>
      <Routes>
        <Route path="/w/:slug/p/:keyPrefix" element={<Project />} />
      </Routes>
    </MemoryRouter>
  );

/** Moves to the settings tab, which every section test starts from. */
const openSettings = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
};

beforeEach(() => {
  for (const spy of [
    listProjects,
    listStatuses,
    createStatus,
    updateStatus,
    deleteStatus,
    listLabels,
    createLabel,
    updateLabel,
    deleteLabel,
    listProjectMembers,
    setProjectMember,
    removeProjectMember,
    listMembers,
  ]) {
    spy.mockReset();
  }
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
  listProjects.mockResolvedValue([project]);
  listStatuses.mockResolvedValue(statuses);
  listLabels.mockResolvedValue([label]);
  listProjectMembers.mockResolvedValue([projectMember]);
  listMembers.mockResolvedValue([]);
  listIssues.mockReset();
  listIssues.mockResolvedValue({ issues: [], next_cursor: null });
});

describe('resolving the project', () => {
  it('shows the project the key prefix names', async () => {
    renderPage();

    expect(await screen.findByText('Engine')).toBeInTheDocument();
    expect(screen.getByText('ENG')).toBeInTheDocument();
  });

  it('says so when no project in the workspace uses that key', async () => {
    renderPage('NOPE');

    expect(await screen.findByText('Project not found')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listProjects.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load this project.')
    ).toBeInTheDocument();
  });

  it('opens on the issues tab, reading this project only', async () => {
    renderPage();

    expect(
      await screen.findByText('No issues in this project match these filters.')
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 'proj-1', sort: 'updated_desc' })
      );
    });
  });

  it('offers the create form to a caller who may write issues', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'New issue' }));

    expect(
      await screen.findByRole('form', { name: 'New issue' })
    ).toBeInTheDocument();
  });

  it('hides the create form from a guest', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...guestProject } = project;
    listProjects.mockResolvedValue([guestProject]);
    renderPage();

    await screen.findByText('Engine');
    expect(
      screen.queryByRole('button', { name: 'New issue' })
    ).not.toBeInTheDocument();
  });
});

describe('the status section', () => {
  it('lists the statuses in position order', async () => {
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    expect(
      await screen.findByLabelText('Name', { selector: '#status-name-st-1' })
    ).toHaveValue('Todo');
    expect(
      screen.getByLabelText('Name', { selector: '#status-name-st-2' })
    ).toHaveValue('Doing');
  });

  it('adds a status at the end of the list', async () => {
    createStatus.mockResolvedValue(todo);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    await user.type(await screen.findByLabelText('New status'), 'Done');
    await user.selectOptions(
      screen.getByLabelText('Category', { selector: '#new-status-category' }),
      'completed'
    );
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
    await openSettings(user);

    const field = await screen.findByLabelText('Name', {
      selector: '#status-name-st-1',
    });
    await user.clear(field);
    await user.type(field, 'Backlog');
    await user.tab();

    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('st-1', { name: 'Backlog' });
    });

    updateStatus.mockClear();
    const other = screen.getByLabelText('Name', {
      selector: '#status-name-st-2',
    });
    await user.click(other);
    await user.tab();

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('reorders by swapping the two positions, since there is no bulk route', async () => {
    updateStatus.mockResolvedValue(todo);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    await user.click(
      await screen.findByRole('button', { name: 'Move Doing up' })
    );

    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('st-2', { position: 0 });
    });
    expect(updateStatus).toHaveBeenCalledWith('st-1', { position: 1 });
  });

  it('disables the move that would run off the end of the list', async () => {
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    expect(
      await screen.findByRole('button', { name: 'Move Todo up' })
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Move Doing down' })
    ).toBeDisabled();
  });

  it('explains the refusal to delete the last status of a category', async () => {
    deleteStatus.mockRejectedValue(new Error('conflict'));
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    const [firstDelete] = await screen.findAllByRole('button', {
      name: 'Delete',
    });
    if (firstDelete === undefined) throw new Error('no delete button rendered');
    await user.click(firstDelete);

    expect(
      await screen.findByText(/A category must keep at least one/)
    ).toBeInTheDocument();
  });
});

describe('the label section', () => {
  it('adds a label with its colour', async () => {
    createLabel.mockResolvedValue(label);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    await user.type(await screen.findByLabelText('New label'), 'needs review');
    await user.click(screen.getByRole('button', { name: 'Add label' }));

    await waitFor(() => {
      expect(createLabel).toHaveBeenCalledWith({
        name: 'needs review',
        color: '#3b82f6',
      });
    });
  });

  it('surfaces a failed label read', async () => {
    listLabels.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    expect(
      await screen.findByText('Could not load the labels.')
    ).toBeInTheDocument();
  });

  it('renames a label on blur', async () => {
    updateLabel.mockResolvedValue(label);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    const field = await screen.findByLabelText('Name', {
      selector: '#label-name-lb-1',
    });
    await user.clear(field);
    await user.type(field, 'defect');
    await user.tab();

    await waitFor(() => {
      expect(updateLabel).toHaveBeenCalledWith('lb-1', { name: 'defect' });
    });
  });
});

describe('the project member section', () => {
  it('lists the members holding a role directly', async () => {
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    expect(await screen.findByText('Other')).toBeInTheDocument();
  });

  it('changes a project role through the row select', async () => {
    setProjectMember.mockResolvedValue(projectMember);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    await user.selectOptions(
      await screen.findByLabelText('Project role for other@example.com'),
      'admin'
    );

    await waitFor(() => {
      expect(setProjectMember).toHaveBeenCalledWith('user-2', {
        role: 'admin',
      });
    });
  });

  it('adds a workspace member who holds no project role yet', async () => {
    listMembers.mockResolvedValue([
      {
        user_id: 'user-3',
        email: 'third@example.com',
        display_name: 'Third',
        role: 'member',
        joined_at: '2026-09-17T00:00:00Z',
      },
    ]);
    setProjectMember.mockResolvedValue(projectMember);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    await user.selectOptions(
      await screen.findByLabelText('Add a member'),
      'user-3'
    );
    await user.click(screen.getByRole('button', { name: 'Add to project' }));

    await waitFor(() => {
      expect(setProjectMember).toHaveBeenCalledWith('user-3', {
        role: 'member',
      });
    });
  });

  it('leaves out anyone who already holds a project role', async () => {
    listMembers.mockResolvedValue([
      {
        user_id: 'user-2',
        email: 'other@example.com',
        display_name: 'Other',
        role: 'member',
        joined_at: '2026-09-17T00:00:00Z',
      },
    ]);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    await screen.findByText('Other');
    expect(screen.queryByLabelText('Add a member')).not.toBeInTheDocument();
  });
});

describe('the capability gates', () => {
  it('shows a workspace member with no project role the settings read only', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listProjects.mockResolvedValue([{ ...project, role: 'member' }]);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    expect(await screen.findByText('Todo')).toBeInTheDocument();
    expect(screen.queryByLabelText('New status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New label')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add to project' })
    ).not.toBeInTheDocument();
  });

  it('lets a project admin edit even when the workspace role would not', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listProjects.mockResolvedValue([{ ...project, role: 'admin' }]);
    const user = userEvent.setup();
    renderPage();
    await openSettings(user);

    expect(await screen.findByLabelText('New status')).toBeInTheDocument();
  });
});
