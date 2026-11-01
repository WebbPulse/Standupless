/**
 * The pending verification screen names the address, resends the link on a
 * cooldown, offers a different email and sign out, and carries on by itself
 * once the address is confirmed elsewhere.
 */

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRead } from '../../types/Api';
import PendingVerification from './PendingVerification';

const requestEmailVerification = vi.fn<(body: unknown) => Promise<unknown>>();
const refreshSession = vi.fn<() => Promise<UserRead | null>>();
const getProfile = vi.fn<(path: string) => Promise<{ data: UserRead }>>();
const logout = vi.fn<(to?: string) => Promise<void>>(() => Promise.resolve());
const user: UserRead = {
  id: 'user-1',
  email: 'new@example.com',
  display_name: 'New',
  email_verified: false,
};

const identityClient = {
  requestEmailVerification: (body: unknown) => requestEmailVerification(body),
  refreshSession: () => refreshSession(),
};

vi.mock('../../api/client', () => ({
  apiClient: { get: (path: string) => getProfile(path) },
}));

vi.mock('../../api/identityClient', () => ({
  CURRENT_USER_PATH: '/api/users/me',
  getIdentityClient: () => identityClient,
  identityOrigin: () => 'https://api.standupless.dev',
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    isBusy: false,
    user,
    login: vi.fn(),
    logout,
    checkAuthStatus: () => Promise.resolve(),
  }),
}));

vi.mock('../account/EmailSection', () => ({
  default: () => <p>email change form</p>,
}));

vi.mock('../layout/PublicShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const renderScreen = () =>
  render(
    <MemoryRouter>
      <PendingVerification />
    </MemoryRouter>
  );

beforeEach(() => {
  requestEmailVerification.mockReset();
  refreshSession.mockReset();
  getProfile.mockReset();
  logout.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingVerification', () => {
  it('names the address the link was sent to', () => {
    renderScreen();

    expect(screen.getByTestId('pending-verification-email')).toHaveTextContent(
      'new@example.com'
    );
    expect(
      screen.getByRole('heading', { name: 'Check your email' })
    ).toBeInTheDocument();
  });

  it('resends the link and holds the button through the cooldown', async () => {
    vi.useFakeTimers();
    requestEmailVerification.mockResolvedValue({ ok: true });
    renderScreen();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Resend verification email' })
      );
      await Promise.resolve();
    });

    expect(requestEmailVerification).toHaveBeenCalledWith({
      email: 'new@example.com',
    });
    expect(
      screen.getByRole('button', { name: 'Resend in 60s' })
    ).toBeDisabled();
    expect(
      screen.getByText('We sent a new link to new@example.com.')
    ).toBeInTheDocument();

    for (let tick = 0; tick < 60; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    expect(
      screen.getByRole('button', { name: 'Resend verification email' })
    ).toBeEnabled();
  });

  it('shows the refusal the server sent rather than a raw error', async () => {
    requestEmailVerification.mockResolvedValue({
      ok: false,
      reason: 'rate-limited',
      message: '',
    });
    renderScreen();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Resend verification email' })
      );
      await Promise.resolve();
    });

    expect(
      screen.getByText('Could not send a new link. Try again in a few minutes.')
    ).toBeInTheDocument();
  });

  it('opens the email change form and signs out', () => {
    renderScreen();

    fireEvent.click(
      screen.getByRole('button', { name: 'Use a different email' })
    );
    expect(screen.getByText('email change form')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalled();
  });

  it('refreshes the session once the profile says verified', async () => {
    getProfile.mockResolvedValue({ data: { ...user, email_verified: true } });
    refreshSession.mockResolvedValue({ ...user, email_verified: true });
    renderScreen();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(getProfile).toHaveBeenCalledWith('/api/users/me');
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1));
  });

  it('leaves the session alone while the profile says unverified', async () => {
    getProfile.mockResolvedValue({ data: user });
    renderScreen();

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(getProfile).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('checks again on the half minute poll and survives a failed read', async () => {
    vi.useFakeTimers();
    getProfile.mockRejectedValue(new Error('offline'));
    renderScreen();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(getProfile).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('pending-verification')).toBeInTheDocument();
  });
});
