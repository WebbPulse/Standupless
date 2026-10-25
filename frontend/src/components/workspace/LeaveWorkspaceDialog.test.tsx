/**
 * The Leave workspace confirmation: that it names the workspace, sends the
 * caller's own removal and then drops the cached reads, forgets the workspace
 * as the one to resume and opens the picker, that the last owner is refused
 * before any request with the reason, and that a refusal shows inline.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import { LAST_WORKSPACE_STORAGE_KEY } from '../../lib/lastWorkspace';
import type { MemberRead, WorkspaceRead, WorkspaceRole } from '../../types/Api';
import LeaveWorkspaceDialog from './LeaveWorkspaceDialog';

const removeMember =
  vi.fn<(workspaceId: string, userId: string) => Promise<void>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const clearPolledQueryCache = vi.fn();
const invalidateQueries = vi.fn();

vi.mock('../../api/workspaces', () => ({
  removeMember: (workspaceId: string, userId: string) =>
    removeMember(workspaceId, userId),
  listMembers: () => listMembers(),
}));

vi.mock('@webbpulse/api-client/react', async () => {
  const actual = await vi.importActual<
    typeof import('@webbpulse/api-client/react')
  >('@webbpulse/api-client/react');
  return {
    ...actual,
    clearPolledQueryCache: () => {
      clearPolledQueryCache();
    },
    invalidateQueries: (key: unknown) => {
      invalidateQueries(key);
    },
  };
});

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

/** The workspace being left, with the caller holding `role`. */
const workspaceAs = (role: WorkspaceRole): WorkspaceRead => ({
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role,
});

/** One roster row holding `role`. */
const memberAs = (userId: string, role: WorkspaceRole): MemberRead => ({
  user_id: userId,
  email: `${userId}@example.com`,
  display_name: userId,
  role,
  joined_at: '2026-09-17T00:00:00Z',
});

/** Mounts the open dialog on a workspace page beside the picker route. */
const renderDialog = (role: WorkspaceRole, onClose = vi.fn()) =>
  render(
    <MemoryRouter initialEntries={['/w/acme/settings']}>
      <Routes>
        <Route
          path="/w/:slug/settings"
          element={
            <LeaveWorkspaceDialog
              open
              onClose={onClose}
              workspace={workspaceAs(role)}
            />
          }
        />
        <Route path="/workspaces" element={<p>Picker page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  removeMember.mockReset();
  listMembers.mockReset();
  clearPolledQueryCache.mockReset();
  invalidateQueries.mockReset();
  localStorage.removeItem(LAST_WORKSPACE_STORAGE_KEY);
});

afterEach(async () => {
  const actual = await vi.importActual<
    typeof import('@webbpulse/api-client/react')
  >('@webbpulse/api-client/react');
  actual.clearPolledQueryCache();
});

describe('LeaveWorkspaceDialog', () => {
  it('names the workspace, leaves it and opens the picker with the cache dropped', async () => {
    removeMember.mockResolvedValue(undefined);
    localStorage.setItem(LAST_WORKSPACE_STORAGE_KEY, 'acme');
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog('member', onClose);

    const dialog = screen.getByRole('dialog', { name: 'Leave Acme' });
    await user.click(
      within(dialog).getByRole('button', { name: 'Leave workspace' })
    );

    expect(await screen.findByText('Picker page')).toBeInTheDocument();
    expect(removeMember).toHaveBeenCalledWith('ws-1', 'user-1');
    expect(onClose).toHaveBeenCalled();
    expect(clearPolledQueryCache).toHaveBeenCalled();
    expect(invalidateQueries).toHaveBeenCalledWith(['workspaces']);
    expect(localStorage.getItem(LAST_WORKSPACE_STORAGE_KEY)).toBeNull();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('refuses the last owner up front and says why', async () => {
    listMembers.mockResolvedValue([
      memberAs('user-1', 'owner'),
      memberAs('user-2', 'admin'),
    ]);
    renderDialog('owner');

    expect(
      await screen.findByText(/You are the only owner of Acme/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Leave workspace' })
    ).toBeDisabled();
    expect(removeMember).not.toHaveBeenCalled();
  });

  it('lets an owner leave while another owner remains', async () => {
    listMembers.mockResolvedValue([
      memberAs('user-1', 'owner'),
      memberAs('user-2', 'owner'),
    ]);
    removeMember.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderDialog('owner');

    const leave = screen.getByRole('button', { name: 'Leave workspace' });
    await waitFor(() => {
      expect(leave).toBeEnabled();
    });
    await user.click(leave);

    expect(await screen.findByText('Picker page')).toBeInTheDocument();
    expect(removeMember).toHaveBeenCalledWith('ws-1', 'user-1');
  });

  it('shows a refusal inline and stays open', async () => {
    removeMember.mockRejectedValue(new Error('refused'));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog('member', onClose);

    await user.click(screen.getByRole('button', { name: 'Leave workspace' }));

    expect(
      await screen.findByText('Could not leave the workspace.')
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(clearPolledQueryCache).not.toHaveBeenCalled();
  });
});
