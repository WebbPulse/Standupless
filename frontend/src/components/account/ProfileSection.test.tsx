/**
 * The profile section: a save sends only the changed fields, swaps the signed
 * in user in place and re-reads the member lists, and a taken username shows
 * the server's sentence.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfileUpdate, UserRead } from '../../types/Api';
import ProfileSection from './ProfileSection';

const updateProfile = vi.fn<(body: UserProfileUpdate) => Promise<UserRead>>();
const login = vi.fn<(user: UserRead) => void>();
const invalidateQueries = vi.fn<(keys: unknown[]) => void>();
const showToast = vi.fn<(message: string) => void>();
const currentUser: UserRead = {
  id: 'user-1',
  email: 'me@example.com',
  display_name: 'ana',
  full_name: 'Ana Lima',
  email_verified: true,
};

vi.mock('../../api/profile', () => ({
  updateProfile: (body: UserProfileUpdate) => updateProfile(body),
}));

vi.mock('../../lib/toast', () => ({
  showToast: (message: string) => showToast(message),
}));

vi.mock('@webbpulse/api-client/react', async () => {
  const actual = await vi.importActual<
    typeof import('@webbpulse/api-client/react')
  >('@webbpulse/api-client/react');
  return {
    ...actual,
    invalidateQueries: (keys: unknown[]) => invalidateQueries(keys),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: currentUser,
    isLoading: false,
    isBusy: false,
    login: (user: UserRead) => login(user),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

beforeEach(() => {
  updateProfile.mockReset();
  login.mockReset();
  invalidateQueries.mockReset();
  showToast.mockReset();
});

describe('ProfileSection', () => {
  it('saves a new username and swaps the signed in user in place', async () => {
    const saved = { ...currentUser, display_name: 'ana-l' };
    updateProfile.mockResolvedValue(saved);
    const user = userEvent.setup();
    render(<ProfileSection workspaceId="ws-1" teamIds={['team-1']} />);

    const username = screen.getByLabelText('Username');
    await user.clear(username);
    await user.type(username, 'ana-l');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(login).toHaveBeenCalledWith(saved));
    expect(updateProfile).toHaveBeenCalledWith({ display_name: 'ana-l' });
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries.mock.calls[0]?.[0]).toHaveLength(3);
    expect(showToast).toHaveBeenCalledWith('Profile saved.');
  });

  it('keeps Save off until something changes', () => {
    render(<ProfileSection />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a username that is not one word', async () => {
    const user = userEvent.setup();
    render(<ProfileSection />);

    const username = screen.getByLabelText('Username');
    await user.clear(username);
    await user.type(username, 'ana lima');

    expect(
      screen.getByText(/A username starts with a letter or number/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('shows the server sentence when the username is taken', async () => {
    updateProfile.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: {
          error_code: 'HANDLE_TAKEN',
          message: 'Someone in your workspace already uses that name',
        },
        url: '/api/users/me/profile',
        method: 'PATCH',
      })
    );
    const user = userEvent.setup();
    render(<ProfileSection />);

    const username = screen.getByLabelText('Username');
    await user.clear(username);
    await user.type(username, 'sam');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText(
        /Someone in your workspace already uses that name/
      )
    ).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });
});
