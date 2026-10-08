/**
 * The workspace picker: that it lists the caller's workspaces when there is a
 * choice, forwards past the choice when there is one or none, still lists a
 * single workspace when asked for on purpose, surfaces a failed read, and
 * opens the highlighted row on Enter. Workspaces open to the caller's email
 * domain are offered beside them and joined in one click.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type {
  JoinableWorkspaceRead,
  MemberRead,
  WorkspaceRead,
} from '../../types/Api';
import Workspaces from './Workspaces';

const listWorkspaces = vi.fn<() => Promise<WorkspaceRead[]>>();

const listJoinableWorkspaces = vi.fn<() => Promise<JoinableWorkspaceRead[]>>();
const joinWorkspace = vi.fn<(workspaceId: string) => Promise<MemberRead>>();

vi.mock('../../api/workspaces', () => ({
  listWorkspaces: () => listWorkspaces(),
  listJoinableWorkspaces: () => listJoinableWorkspaces(),
  joinWorkspace: (workspaceId: string) => joinWorkspace(workspaceId),
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

vi.mock('../../hooks/useAuth', () => ({
  useAuth: (): AuthContextType => ({
    isAuthenticated: true,
    isLoading: false,
    isBusy: false,
    user: {
      id: 'user-1',
      email: 'someone@example.com',
      display_name: 'Someone',
      email_verified: true,
    },
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

/** One workspace row as the list route answers it. */
const mine: WorkspaceRead = {
  id: 'ws-1',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'owner',
};

/** A second workspace, so the picker has a choice to show. */
const theirs: WorkspaceRead = {
  ...mine,
  id: 'ws-2',
  name: 'Theirs',
  slug: 'theirs',
  role: 'member',
};

/** Mounts the picker at `entry` beside the routes it may forward to. */
const renderAt = (entry = '/workspaces') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/workspaces" element={<Workspaces />} />
        <Route path="/workspaces/new" element={<p>Create page</p>} />
        <Route path="/w/:slug" element={<p>Workspace page</p>} />
      </Routes>
    </MemoryRouter>
  );

/** A workspace open to the caller's verified email domain. */
const open: JoinableWorkspaceRead = {
  id: 'ws-3',
  name: 'Example',
  slug: 'example',
  domain: 'example.com',
};

beforeEach(() => {
  listWorkspaces.mockReset();
  listJoinableWorkspaces.mockReset();
  joinWorkspace.mockReset();
  listJoinableWorkspaces.mockResolvedValue([]);
});

describe('Workspaces', () => {
  it('lists every workspace when there is a choice to make', async () => {
    listWorkspaces.mockResolvedValue([mine, theirs]);
    renderAt();

    expect(await screen.findByRole('link', { name: /Mine/ })).toHaveAttribute(
      'href',
      '/w/mine'
    );
    expect(screen.getByRole('link', { name: /Theirs/ })).toHaveAttribute(
      'href',
      '/w/theirs'
    );
    expect(
      screen.getByRole('link', { name: /Create a workspace/ })
    ).toHaveAttribute('href', '/workspaces/new');
    expect(screen.getByText('Signed in as someone@example.com')).toBeVisible();
  });

  it('forwards straight into the only workspace', async () => {
    listWorkspaces.mockResolvedValue([mine]);
    renderAt();

    expect(await screen.findByText('Workspace page')).toBeInTheDocument();
  });

  it('still lists a single workspace when asked for all of them', async () => {
    listWorkspaces.mockResolvedValue([mine]);
    renderAt('/workspaces?all=1');

    expect(
      await screen.findByRole('link', { name: /Mine/ })
    ).toBeInTheDocument();
    expect(screen.queryByText('Workspace page')).not.toBeInTheDocument();
  });

  it('sends someone with no workspace to create one', async () => {
    listWorkspaces.mockResolvedValue([]);
    renderAt();

    expect(await screen.findByText('Create page')).toBeInTheDocument();
  });

  it('offers a workspace open to the email domain instead of creating one', async () => {
    listWorkspaces.mockResolvedValue([]);
    listJoinableWorkspaces.mockResolvedValue([open]);
    renderAt();

    expect(
      await screen.findByText('Open to verified example.com emails')
    ).toBeInTheDocument();
    expect(screen.queryByText('Create page')).not.toBeInTheDocument();
  });

  it('does not forward past a single workspace while another can be joined', async () => {
    listWorkspaces.mockResolvedValue([mine]);
    listJoinableWorkspaces.mockResolvedValue([open]);
    renderAt();

    expect(
      await screen.findByRole('button', { name: 'Join Example' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Workspace page')).not.toBeInTheDocument();
  });

  it('joins a workspace and opens it', async () => {
    listWorkspaces.mockResolvedValue([]);
    listJoinableWorkspaces.mockResolvedValue([open]);
    joinWorkspace.mockResolvedValue({
      user_id: 'user-1',
      email: 'someone@example.com',
      display_name: 'Someone',
      role: 'member',
      joined_at: '2026-10-07T00:00:00Z',
    });
    renderAt();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Join Example' })
    );

    await waitFor(() => {
      expect(joinWorkspace).toHaveBeenCalledWith('ws-3');
    });
    expect(await screen.findByText('Workspace page')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listWorkspaces.mockRejectedValue(new Error('boom'));
    renderAt();

    expect(
      await screen.findByText('Could not load your workspaces.')
    ).toBeInTheDocument();
  });

  it('opens the highlighted workspace on Enter', async () => {
    listWorkspaces.mockResolvedValue([mine, theirs]);
    const user = userEvent.setup();
    renderAt();
    await screen.findByRole('link', { name: /Mine/ });

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(await screen.findByText('Workspace page')).toBeInTheDocument();
  });
});
