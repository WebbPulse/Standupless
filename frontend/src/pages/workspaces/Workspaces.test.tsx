/**
 * The workspace list page: what it shows while loading, empty and populated,
 * that the slug is derived from the name until it is edited by hand, that the
 * contract's slug rule gates the submit, and that a failed read or create is
 * surfaced rather than swallowed.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { WorkspaceRead } from '../../types/Api';
import Workspaces from './Workspaces';

const listWorkspaces = vi.fn<() => Promise<WorkspaceRead[]>>();
const createWorkspace =
  vi.fn<(body: { name: string; slug: string }) => Promise<WorkspaceRead>>();

vi.mock('../../api/workspaces', () => ({
  listWorkspaces: () => listWorkspaces(),
  createWorkspace: (body: { name: string; slug: string }) =>
    createWorkspace(body),
}));

vi.mock('../../hooks/useQueryAuth', () => ({
  useQueryAuth: () => undefined,
}));

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

/** A settled signed in session, which is the only state this page renders in. */
const session = (): AuthContextType => ({
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
});

/** One workspace row as the list route answers it. */
const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'owner',
};

/** Mounts the page inside a router, which its links require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <Workspaces />
    </MemoryRouter>
  );

beforeEach(() => {
  listWorkspaces.mockReset();
  createWorkspace.mockReset();
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue(session());
});

describe('Workspaces', () => {
  it('lists the workspaces the caller belongs to', async () => {
    listWorkspaces.mockResolvedValue([workspace]);
    renderPage();

    expect(await screen.findByText('Mine')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Mine/ })).toHaveAttribute(
      'href',
      '/w/mine'
    );
  });

  it('says so when the caller belongs to none', async () => {
    listWorkspaces.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText(/not a member of any workspace yet/)
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listWorkspaces.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load your workspaces.')
    ).toBeInTheDocument();
  });

  it('derives the slug from the name until the slug is edited by hand', async () => {
    listWorkspaces.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/not a member of any workspace yet/);

    await user.type(screen.getByLabelText('Name'), 'My Great Team');

    expect(screen.getByLabelText('Slug')).toHaveValue('my-great-team');

    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'chosen');
    await user.type(screen.getByLabelText('Name'), '!');

    expect(screen.getByLabelText('Slug')).toHaveValue('chosen');
  });

  it('refuses to submit a slug the contract would reject', async () => {
    listWorkspaces.mockResolvedValue([]);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/not a member of any workspace yet/);

    await user.type(screen.getByLabelText('Name'), 'Mine');
    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'No Spaces');

    expect(
      screen.getByRole('button', { name: 'Create workspace' })
    ).toBeDisabled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('creates a workspace and clears the form', async () => {
    listWorkspaces.mockResolvedValue([]);
    createWorkspace.mockResolvedValue(workspace);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/not a member of any workspace yet/);

    await user.type(screen.getByLabelText('Name'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({
        name: 'Mine',
        slug: 'mine',
      });
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Name')).toHaveValue('');
    });
  });

  it('surfaces a refused create and keeps what was typed', async () => {
    listWorkspaces.mockResolvedValue([]);
    createWorkspace.mockRejectedValue(new Error('slug taken'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/not a member of any workspace yet/);

    await user.type(screen.getByLabelText('Name'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(
      await screen.findByText('Could not create the workspace.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Mine');
  });
});
