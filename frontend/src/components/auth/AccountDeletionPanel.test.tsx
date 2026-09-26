/**
 * The account deletion panel: the sole owner block with its links, the plan in
 * the dialog, the typed address, and the scheduled banner with its cancel.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountDeletionPlanRead, UserRead } from '../../types/Api';
import AccountDeletionPanel from './AccountDeletionPanel';

const getAccountDeletionPlan = vi.fn<() => Promise<AccountDeletionPlanRead>>();
const scheduleAccountDeletion = vi.fn<(body: unknown) => Promise<UserRead>>();
const cancelAccountDeletion = vi.fn<() => Promise<UserRead>>();
const checkAuthStatus = vi.fn(() => Promise.resolve());
const stepUpWithPasskey = vi.fn<() => Promise<unknown>>();
let currentUser: UserRead | null = null;

vi.mock('../../api/account', () => ({
  getAccountDeletionPlan: () => getAccountDeletionPlan(),
  scheduleAccountDeletion: (body: unknown) => scheduleAccountDeletion(body),
  cancelAccountDeletion: () => cancelAccountDeletion(),
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
    logout: vi.fn(),
    checkAuthStatus,
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

/** The signed in user, with no deletion scheduled unless given a date. */
const userWith = (purgeAfter: string | null = null): UserRead => ({
  id: 'user-1',
  email: 'me@example.com',
  display_name: 'Me',
  email_verified: true,
  purge_after: purgeAfter,
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
  scheduleAccountDeletion.mockReset();
  cancelAccountDeletion.mockReset();
  checkAuthStatus.mockClear();
  stepUpWithPasskey.mockReset();
  currentUser = userWith();
});

describe('AccountDeletionPanel', () => {
  it('blocks a sole owner and links each workspace to hand over', async () => {
    getAccountDeletionPlan.mockResolvedValue({
      ...clearPlan,
      blocking: [{ id: 'w3', name: 'Shared', slug: 'shared' }],
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
    expect(
      screen.queryByRole('button', { name: 'Delete account' })
    ).not.toBeInTheDocument();
  });

  it('shows the plan, takes the address in any case, and schedules', async () => {
    getAccountDeletionPlan.mockResolvedValue(clearPlan);
    stepUpWithPasskey.mockResolvedValue({ ok: true, expiresIn: 900 });
    scheduleAccountDeletion.mockResolvedValue(userWith('2026-10-10T12:00:00Z'));
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Delete account' })
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Solo')).toBeInTheDocument();
    expect(within(dialog).getByText('Team Space')).toBeInTheDocument();
    expect(within(dialog).getByText(/deleted user/)).toBeInTheDocument();

    await user.type(
      within(dialog).getByLabelText('Type me@example.com to confirm'),
      'Me@Example.com'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Schedule deletion' })
    );

    await waitFor(() => {
      expect(scheduleAccountDeletion).toHaveBeenCalledWith({
        confirm_email: 'Me@Example.com',
      });
    });
    expect(
      await screen.findByText(/Your account will be permanently deleted on/)
    ).toBeInTheDocument();
    expect(checkAuthStatus).toHaveBeenCalled();
  });

  it('cancels a scheduled deletion', async () => {
    currentUser = userWith('2026-10-10T12:00:00Z');
    getAccountDeletionPlan.mockResolvedValue(clearPlan);
    cancelAccountDeletion.mockResolvedValue(userWith());
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Cancel deletion' })
    );

    await waitFor(() => {
      expect(cancelAccountDeletion).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByRole('button', { name: 'Delete account' })
    ).toBeInTheDocument();
  });
});
