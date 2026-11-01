/**
 * Opening a verification link carries a signed in browser on to its
 * workspaces with a token that carries the confirmed address, asks a signed
 * out one to sign in, and treats an already spent link as done for an account
 * that is verified and as no failure for a browser that cannot tell.
 */

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import VerifyEmailToken from './VerifyEmailToken';

const linkState = vi.fn<() => unknown>();
const useAuthMock = vi.fn<() => AuthContextType>();
const refresh = vi.fn<() => Promise<string | null>>();

vi.mock('@webbpulse/auth/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@webbpulse/auth/react')>()),
  useEmailVerificationLink: () => linkState(),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({ refresh: () => refresh() }),
  identityOrigin: () => 'https://api.standupless.dev',
}));

vi.mock('../../components/layout/PublicShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

/** A session value, signed in and settled unless overridden. */
const session = (
  overrides: Partial<AuthContextType> = {}
): AuthContextType => ({
  isAuthenticated: true,
  isLoading: false,
  isBusy: false,
  user: {
    id: 'user-1',
    email: 'new@example.com',
    display_name: 'New',
    email_verified: false,
  },
  login: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  checkAuthStatus: vi.fn(() => Promise.resolve()),
  ...overrides,
});

const renderLink = () =>
  render(
    <MemoryRouter initialEntries={['/verify-email?token=abc']}>
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailToken />} />
        <Route path="/workspaces" element={<p>workspaces page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  linkState.mockReset();
  useAuthMock.mockReset();
  refresh.mockReset();
  refresh.mockResolvedValue('token');
});

describe('VerifyEmailToken', () => {
  it('rotates the token, rereads the profile and opens the workspaces', async () => {
    const value = session();
    useAuthMock.mockReturnValue(value);
    linkState.mockReturnValue({ kind: 'confirmed' });

    await act(async () => {
      renderLink();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(value.checkAuthStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByText('workspaces page')).toBeInTheDocument();
  });

  it('asks a browser without a session to sign in', async () => {
    useAuthMock.mockReturnValue(
      session({ isAuthenticated: false, user: null })
    );
    linkState.mockReturnValue({ kind: 'confirmed' });

    await act(async () => {
      renderLink();
      await Promise.resolve();
    });

    expect(
      screen.getByText('Your email address is verified.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('carries a verified account on past a link that was already spent', async () => {
    useAuthMock.mockReturnValue(
      session({
        user: {
          id: 'user-1',
          email: 'new@example.com',
          display_name: 'New',
          email_verified: true,
        },
      })
    );
    linkState.mockReturnValue({
      kind: 'refused',
      reason: 'invalid-link',
      message: '',
    });

    await act(async () => {
      renderLink();
      await Promise.resolve();
    });

    expect(screen.getByText('workspaces page')).toBeInTheDocument();
  });

  it('asks a browser without a session to sign in past a spent link', async () => {
    useAuthMock.mockReturnValue(
      session({ isAuthenticated: false, user: null })
    );
    linkState.mockReturnValue({
      kind: 'refused',
      reason: 'invalid-link',
      message: 'This link has expired.',
    });

    await act(async () => {
      renderLink();
      await Promise.resolve();
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.queryByText('This link has expired.')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'sign in' })).toHaveAttribute(
      'href',
      '/login'
    );
  });

  it('holds on the spinner while the session behind a spent link settles', async () => {
    useAuthMock.mockReturnValue(
      session({ isAuthenticated: false, isLoading: true, user: null })
    );
    linkState.mockReturnValue({
      kind: 'refused',
      reason: 'invalid-link',
      message: '',
    });

    await act(async () => {
      renderLink();
      await Promise.resolve();
    });

    expect(screen.queryByText(/no longer valid/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'sign in' })
    ).not.toBeInTheDocument();
  });

  it('explains a spent link to an account that is still unverified', async () => {
    useAuthMock.mockReturnValue(session());
    linkState.mockReturnValue({
      kind: 'refused',
      reason: 'invalid-link',
      message: '',
    });

    await act(async () => {
      renderLink();
      await Promise.resolve();
    });

    expect(
      screen.getByText(
        'This link is no longer valid. Verification links expire and can only be used once.'
      )
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
