/**
 * The Workflow group of the account preferences: each switch reads the
 * account's stored value, with auto-assign off and both branch copy switches
 * on by default, and flipping one saves only that field and keeps the answer.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserPreferencesUpdate, UserRead } from '../../types/Api';
import PreferencesSection from './PreferencesSection';

const updatePreferences =
  vi.fn<(body: UserPreferencesUpdate) => Promise<UserRead>>();
const login = vi.fn<(user: UserRead) => void>();
const authState: { user: UserRead } = {
  user: {
    id: 'user-1',
    email: 'me@example.com',
    display_name: 'ana',
    email_verified: true,
  },
};

vi.mock('../../api/notifications', () => ({
  updatePreferences: (body: UserPreferencesUpdate) => updatePreferences(body),
}));

vi.mock('@webbpulse/api-client/react', async () => {
  const actual = await vi.importActual<
    typeof import('@webbpulse/api-client/react')
  >('@webbpulse/api-client/react');
  return { ...actual, invalidateQueries: vi.fn() };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: authState.user,
    isLoading: false,
    isBusy: false,
    login: (user: UserRead) => login(user),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

const base: UserRead = {
  id: 'user-1',
  email: 'me@example.com',
  display_name: 'ana',
  email_verified: true,
};

beforeEach(() => {
  updatePreferences.mockReset();
  login.mockReset();
  authState.user = base;
});

/** The switch with the given accessible name. */
const toggle = (name: string): HTMLElement =>
  screen.getByRole('switch', { name });

const AUTO_ASSIGN = 'Auto-assign to self';
const STARTS = 'On git branch copy, move issue to started status';
const ASSIGNS = 'On git branch copy, assign to me';

describe('PreferencesSection workflow', () => {
  it('reads the defaults for an account with nothing stored', () => {
    render(<PreferencesSection />);

    expect(screen.getByText('Workflow')).toBeInTheDocument();
    expect(toggle(AUTO_ASSIGN)).toHaveAttribute('aria-checked', 'false');
    expect(toggle(STARTS)).toHaveAttribute('aria-checked', 'true');
    expect(toggle(ASSIGNS)).toHaveAttribute('aria-checked', 'true');
  });

  it('turns auto-assign on and keeps the stored answer', async () => {
    const saved = { ...base, auto_assign_to_self: true };
    updatePreferences.mockResolvedValue(saved);
    const user = userEvent.setup();
    render(<PreferencesSection />);

    await user.click(toggle(AUTO_ASSIGN));

    expect(updatePreferences).toHaveBeenCalledWith({
      auto_assign_to_self: true,
    });
    await waitFor(() => expect(login).toHaveBeenCalledWith(saved));
  });

  it('turns each branch copy switch off on its own', async () => {
    updatePreferences.mockResolvedValue(base);
    const user = userEvent.setup();
    render(<PreferencesSection />);

    await user.click(toggle(STARTS));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    await user.click(toggle(ASSIGNS));

    expect(updatePreferences.mock.calls.map(([body]) => body)).toEqual([
      { branch_copy_starts: false },
      { branch_copy_assigns: false },
    ]);
  });

  it('turns a switch stored off back on', async () => {
    authState.user = {
      ...base,
      auto_assign_to_self: true,
      branch_copy_starts: false,
      branch_copy_assigns: false,
    };
    updatePreferences.mockResolvedValue(authState.user);
    const user = userEvent.setup();
    render(<PreferencesSection />);

    expect(toggle(AUTO_ASSIGN)).toHaveAttribute('aria-checked', 'true');
    expect(toggle(STARTS)).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle(STARTS));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    await user.click(toggle(AUTO_ASSIGN));

    expect(updatePreferences.mock.calls.map(([body]) => body)).toEqual([
      { branch_copy_starts: true },
      { auto_assign_to_self: false },
    ]);
  });
});
