/**
 * The shared polled query cache ends with the session. Several cached keys,
 * such as a team's statuses or the current user, carry no user, so a sign out
 * here and a session that ends some other way both empty the cache before the
 * next person can paint from it.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuth } from '../hooks/useAuth';
import { AuthProvider } from './AuthContext';

const clearPolledQueryCache = vi.fn();

vi.mock('@webbpulse/api-client/react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clearPolledQueryCache: () => {
    clearPolledQueryCache();
  },
}));

/** The package session the provider reads, changed per test. */
const session = {
  isAuthenticated: true,
  isLoading: false,
  isBusy: false,
  user: { id: 'u-1', timezone: 'UTC' } as unknown,
  setUser: vi.fn(),
  reloadUser: vi.fn(() => Promise.resolve()),
  logout: vi.fn(() => Promise.resolve()),
};

vi.mock('@webbpulse/auth/react', () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useAuth: () => session,
}));

vi.mock('../api/identityClient', () => ({
  getIdentityClient: () => ({}),
}));

/** A sign out button, as the sidebar menu renders one. */
const SignOut: React.FC = () => {
  const { logout } = useAuth();
  return (
    <button type="button" onClick={() => void logout()}>
      Sign out
    </button>
  );
};

/** Renders the provider around a sign out button. */
const renderProvider = () =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <SignOut />
      </AuthProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  clearPolledQueryCache.mockReset();
  session.isAuthenticated = true;
  session.isLoading = false;
  session.user = { id: 'u-1', timezone: 'UTC' };
});

describe('the polled query cache across sign out', () => {
  it('is emptied by a sign out', async () => {
    renderProvider();
    expect(clearPolledQueryCache).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => {
      expect(clearPolledQueryCache).toHaveBeenCalled();
    });
    expect(session.logout).toHaveBeenCalled();
  });

  it('is emptied when the session ends some other way', () => {
    const { rerender } = renderProvider();
    expect(clearPolledQueryCache).not.toHaveBeenCalled();

    session.isAuthenticated = false;
    session.user = null;
    rerender(
      <MemoryRouter>
        <AuthProvider>
          <SignOut />
        </AuthProvider>
      </MemoryRouter>
    );

    expect(clearPolledQueryCache).toHaveBeenCalledTimes(1);
  });

  it('is left alone for a visitor who was never signed in', () => {
    session.isAuthenticated = false;
    session.user = null;

    renderProvider();

    expect(clearPolledQueryCache).not.toHaveBeenCalled();
  });
});
