/**
 * The issue peek pane. Covers that it reads the issue by id and shows its
 * title, properties and description, that a property change applies at once
 * through the same pickers as the rail, that it links to the full page, and
 * that Escape and the close button dismiss it while Escape inside a picker
 * only closes the picker.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  IssueRead,
  StatusRead,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import { clearToasts } from '../../lib/toast';
import IssuePeek from './IssuePeek';

const getIssue = vi.fn<(id: string) => Promise<IssueRead>>();
const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../api/issues', () => ({
  getIssue: (_w: string, id: string) => getIssue(id),
  updateIssue: (_w: string, id: string, body: unknown) => updateIssue(id, body),
  listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
}));

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'st-2', name: 'Doing', category: 'started', position: 1 },
];

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve(statuses),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
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

vi.mock('../../hooks/useAuth', () => ({
  useAuth: (): Partial<AuthContextType> => ({
    isAuthenticated: true,
    user: {
      id: 'user-1',
      email: 'someone@example.com',
      display_name: 'Someone',
      email_verified: true,
    },
  }),
}));

const team: TeamRead = {
  id: 't-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  key: 'ENG-7',
  number: 7,
  title: 'Peek at me',
  body: 'The long story',
  status_id: 'st-1',
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
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** A resolved workspace with the caller holding `role`. */
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
  refresh: () => Promise.resolve(),
});

const onClose = vi.fn<() => void>();

const renderPeek = () =>
  render(
    <MemoryRouter>
      <IssuePeek issueId="iss-1" onClose={onClose} />
    </MemoryRouter>
  );

beforeEach(() => {
  for (const spy of [getIssue, updateIssue, listTeams, onClose])
    spy.mockReset();
  clearToasts();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  getIssue.mockResolvedValue(issue);
  updateIssue.mockImplementation((_id, body) =>
    Promise.resolve({
      ...issue,
      ...(body as object),
      updated_at: '2026-09-18T00:00:00Z',
    })
  );
  listTeams.mockResolvedValue([team]);
});

describe('IssuePeek', () => {
  it('shows the title, description and properties of the issue', async () => {
    renderPeek();

    expect(await screen.findByText('Peek at me')).toBeInTheDocument();
    expect(getIssue).toHaveBeenCalledWith('iss-1');
    expect(screen.getByText('The long story')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Status: Todo' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: 'Issue ENG-7' })
    ).toBeInTheDocument();
  });

  it('links to the full page by key', async () => {
    renderPeek();

    expect(
      await screen.findByRole('link', { name: 'Open full page' })
    ).toHaveAttribute('href', '/w/mine/issues/ENG-7');
  });

  it('applies a property change at once and writes it', async () => {
    const user = userEvent.setup();
    renderPeek();

    await user.click(
      await screen.findByRole('button', { name: 'Status: Todo' })
    );
    await user.keyboard('2');

    expect(
      screen.getByRole('button', { name: 'Status: Doing' })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { status_id: 'st-2' });
    });
  });

  it('closes on Escape, but not while a picker is open', async () => {
    const user = userEvent.setup();
    renderPeek();

    await user.click(
      await screen.findByRole('button', { name: 'Status: Todo' })
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    renderPeek();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks the pickers for a guest without team access', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...guestTeam } = team;
    listTeams.mockResolvedValue([guestTeam]);
    renderPeek();

    expect(
      await screen.findByRole('button', { name: 'Status: Todo' })
    ).toBeDisabled();
  });
});
