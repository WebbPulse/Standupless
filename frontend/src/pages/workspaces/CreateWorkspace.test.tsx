/**
 * The create workspace page: the URL is derived from the name until it is
 * edited by hand, the contract's slug rule gates the submit, a created
 * workspace opens, and a refused create is surfaced with the form kept.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { WorkspaceRead } from '../../types/Api';
import CreateWorkspace from './CreateWorkspace';

const createWorkspace =
  vi.fn<(body: { name: string; slug: string }) => Promise<WorkspaceRead>>();

vi.mock('../../api/workspaces', () => ({
  createWorkspace: (body: { name: string; slug: string }) =>
    createWorkspace(body),
}));

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

/** The workspace the create route answers with. */
const created: WorkspaceRead = {
  id: 'ws-1',
  name: 'My Great Team',
  slug: 'my-great-team',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'owner',
};

/** Mounts the page beside the workspace route it opens on success. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/workspaces/new']}>
      <Routes>
        <Route path="/workspaces/new" element={<CreateWorkspace />} />
        <Route path="/w/:slug" element={<p>Workspace page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  createWorkspace.mockReset();
});

describe('CreateWorkspace', () => {
  it('derives the URL from the name until it is edited by hand', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Workspace name'), 'My Great Team');
    expect(screen.getByLabelText('Workspace URL')).toHaveValue('my-great-team');

    await user.clear(screen.getByLabelText('Workspace URL'));
    await user.type(screen.getByLabelText('Workspace URL'), 'chosen');
    await user.type(screen.getByLabelText('Workspace name'), '!');

    expect(screen.getByLabelText('Workspace URL')).toHaveValue('chosen');
  });

  it('refuses to submit a URL the contract would reject', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Workspace name'), 'Mine');
    await user.clear(screen.getByLabelText('Workspace URL'));
    await user.type(screen.getByLabelText('Workspace URL'), 'No Spaces');

    expect(
      screen.getByRole('button', { name: 'Create workspace' })
    ).toBeDisabled();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('creates the workspace and opens it', async () => {
    createWorkspace.mockResolvedValue(created);
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Workspace name'), 'My Great Team');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(await screen.findByText('Workspace page')).toBeInTheDocument();
    expect(createWorkspace).toHaveBeenCalledWith({
      name: 'My Great Team',
      slug: 'my-great-team',
    });
  });

  it('surfaces a refused create and keeps what was typed', async () => {
    createWorkspace.mockRejectedValue(new Error('slug taken'));
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Workspace name'), 'Mine');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(
      await screen.findByText('Could not create the workspace.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Workspace name')).toHaveValue('Mine');
  });
});
