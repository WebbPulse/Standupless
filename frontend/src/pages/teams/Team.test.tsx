/**
 * The team page. Covers resolving the key prefix out of the team list and the
 * issue list it opens on. The settings sections moved to their own route and
 * are covered by TeamSettings.test.tsx.
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
  TeamMemberRead,
  TeamRead,
  StatusRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Team from './Team';

const listTeams = vi.fn<() => Promise<TeamRead[]>>();
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
const listTeamMembers = vi.fn<() => Promise<TeamMemberRead[]>>();
const setTeamMember =
  vi.fn<(userId: string, body: unknown) => Promise<TeamMemberRead>>();
const removeTeamMember = vi.fn<(userId: string) => Promise<void>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();

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

vi.mock('../../api/issues', () => ({
  ME: 'me',
  listIssues: (_w: string, query: unknown) => listIssues(query),
  appendIssues: (held: unknown[], page: { issues: unknown[] }) => [
    ...held,
    ...page.issues,
  ],
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
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
  listTeamMembers: () => listTeamMembers(),
  setTeamMember: (_w: string, _p: string, userId: string, body: unknown) =>
    setTeamMember(userId, body),
  removeTeamMember: (_w: string, _p: string, userId: string) =>
    removeTeamMember(userId),
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

/** A resolved workspace context with the caller holding 'role'. */
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

/** Mounts the team route with 'keyPrefix' in the path. */
const renderPage = (keyPrefix = 'ENG') =>
  render(
    <MemoryRouter initialEntries={[`/w/mine/team/${keyPrefix}`]}>
      <Routes>
        <Route path="/w/:slug/team/:keyPrefix" element={<Team />} />
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
  listIssues.mockReset();
  listIssues.mockResolvedValue({ issues: [], next_cursor: null });
});

describe('resolving the team', () => {
  it('shows the team the key prefix names', async () => {
    renderPage();

    expect(await screen.findByText('Engine')).toBeInTheDocument();
    expect(screen.getByText('ENG')).toBeInTheDocument();
  });

  it('says so when no team in the workspace uses that key', async () => {
    renderPage('NOPE');

    expect(await screen.findByText('Team not found')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listTeams.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load this team.')
    ).toBeInTheDocument();
  });

  it('opens on the issue list, reading this team only', async () => {
    renderPage();

    expect(
      await screen.findByText('No issues in this team match these filters.')
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listIssues).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: 'proj-1', sort: 'updated_desc' })
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
    const { role: _role, ...guestTeam } = team;
    listTeams.mockResolvedValue([guestTeam]);
    renderPage();

    await screen.findByText('Engine');
    expect(
      screen.queryByRole('button', { name: 'New issue' })
    ).not.toBeInTheDocument();
  });
});
