/**
 * The account deletion panel: the sole owner block with its links, the plan in
 * the dialog, the typed address, and the sign out onto the confirmation page.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDeletionPlanRead, UserRead } from '../../types/Api';
import AccountDeletionPanel from './AccountDeletionPanel';

const getAccountDeletionPlan = vi.fn<() => Promise<AccountDeletionPlanRead>>();
const deleteAccount = vi.fn<(body: unknown) => Promise<void>>();
const logout = vi.fn<(to?: string) => Promise<void>>(() => Promise.resolve());
const stepUpWithPasskey = vi.fn<() => Promise<unknown>>();
const currentUser: UserRead = {
  id: 'user-1',
  email: 'me@example.com',
  display_name: 'Me',
  email_verified: true,
};

vi.mock('../../api/account', () => ({
  getAccountDeletionPlan: () => getAccountDeletionPlan(),
  deleteAccount: (body: unknown) => deleteAccount(body),
}));

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({
    stepUpWithPasskey: () => stepUpWithPasskey(),
    stepUp: vi.fn(),
  }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: currentUser,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: (to?: string) => logout(to),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
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

/** A plan with nothing blocking, one solo workspace and one shared one. */
const clearPlan: AccountDeletionPlanRead = {
  blocking: [],
  deleted_with_account: [{ id: 'w1', name: 'Solo', slug: 'solo' }],
  leaving: [{ id: 'w2', name: 'Team Space', slug: 'team-space' }],
};

/** Mounts the panel inside a router, which its workspace links require. */
const renderPanel = () =>
  render(
    <MemoryRouter>
      <AccountDeletionPanel />
    </MemoryRouter>
  );

beforeEach(() => {
  getAccountDeletionPlan.mockReset();
  deleteAccount.mockReset();
  logout.mockClear();
  stepUpWithPasskey.mockReset();
});

describe('AccountDeletionPanel', () => {
  it('blocks a sole owner and links each workspace to hand over', async () => {
    getAccountDeletionPlan.mockResolvedValue({
      ...clearPlan,
      blocking: [
        { id: 'w3', name: 'Shared', slug: 'shared' },
        {
          id: 'w4',
          name: 'Winding Down',
          slug: 'winding-down',
          deletion_scheduled: true,
        },
      ],
    });
    renderPanel();

    expect(
      await screen.findByText(
        'You are the only owner of workspaces other people still use.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shared' })).toHaveAttribute(
      'href',
      '/w/shared/settings'
    );
    expect(screen.getByText('(deletion scheduled)')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete account' })
    ).not.toBeInTheDocument();
  });

  it('shows the plan, takes the address in any case, deletes and signs out', async () => {
    getAccountDeletionPlan.mockResolvedValue(clearPlan);
    stepUpWithPasskey.mockResolvedValue({ ok: true, expiresIn: 900 });
    deleteAccount.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Delete account' })
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Solo')).toBeInTheDocument();
    expect(within(dialog).getByText('Team Space')).toBeInTheDocument();
    expect(within(dialog).getByText(/deleted user/)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/can cancel|grace/i)
    ).not.toBeInTheDocument();

    await user.type(
      within(dialog).getByLabelText('Type me@example.com to confirm'),
      'Me@Example.com'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete account' })
    );

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalledWith({
        confirm_email: 'Me@Example.com',
      });
    });
    await waitFor(() => {
      expect(logout).toHaveBeenCalledWith('/account-deleted');
    });
  });

  it('stays signed in and says so when the deletion is refused', async () => {
    getAccountDeletionPlan.mockResolvedValue(clearPlan);
    stepUpWithPasskey.mockResolvedValue({ ok: true, expiresIn: 900 });
    deleteAccount.mockRejectedValue(new Error('refused'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Delete account' })
    );
    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Type me@example.com to confirm'),
      'me@example.com'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Delete account' })
    );

    await waitFor(() => {
      expect(deleteAccount).toHaveBeenCalledTimes(1);
    });
    expect(logout).not.toHaveBeenCalled();
  });
});
