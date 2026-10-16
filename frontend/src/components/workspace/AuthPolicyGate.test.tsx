/**
 * The auth policy gate: for a missing second factor it names the workspace,
 * links to account security, and "Try again" refreshes the session before
 * re-reading the workspace list. For a refused sign-in method it lists the
 * allowed methods and offers to sign out. For a required single sign-on it
 * starts the workspace's connection, signs out, then leaves for the provider.
 */

import { ApiError } from '@webbpulse/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRead } from '../../types/Api';
import AuthPolicyGate from './AuthPolicyGate';

const calls: string[] = [];
const logout = vi.fn(() => {
  calls.push('logout');
  return Promise.resolve();
});
const startSsoSignIn = vi.fn((_body: unknown) => {
  calls.push('start');
  return Promise.resolve({
    authorization_url: 'https://login.example.com/authorize?state=s1',
    connection_id: 'ws-1',
  });
});
const assign = vi.fn((url: string) => {
  calls.push(`assign ${url}`);
});

vi.mock('../../api/sso', () => ({
  startSsoSignIn: (body: unknown) => startSsoSignIn(body),
}));
const refresh = vi.fn(() => {
  calls.push('refresh');
  return Promise.resolve('token');
});

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({ refresh: () => refresh() }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout,
    checkAuthStatus: vi.fn(),
  }),
}));

const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Engineering',
  slug: 'engineering',
  plan: 'business',
  created_at: '2026-09-17T00:00:00Z',
  role: 'member',
  auth_policy_blocked: true,
  auth_policy_reason: 'two_factor',
};

const methodRefused: WorkspaceRead = {
  ...workspace,
  auth_policy_reason: 'sign_in_method',
  auth_policy_allowed_methods: ['github', 'google'],
};

const ssoRequired: WorkspaceRead = {
  ...workspace,
  auth_policy_reason: 'sso',
};

beforeEach(() => {
  calls.length = 0;
  refresh.mockClear();
  logout.mockClear();
  startSsoSignIn.mockClear();
  assign.mockClear();
  vi.stubGlobal('location', { ...window.location, assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the auth policy gate', () => {
  it('explains the requirement and links to account security', () => {
    render(
      <MemoryRouter>
        <AuthPolicyGate
          workspace={workspace}
          onRetry={() => Promise.resolve()}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', {
        name: 'Engineering requires two-factor authentication',
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Set up two-factor authentication' })
    ).toHaveAttribute('href', '/security');
    expect(
      screen.getByText(/Add an authenticator app or a passkey/)
    ).toBeInTheDocument();
  });

  it('refreshes the session before checking again', async () => {
    const onRetry = vi.fn(() => {
      calls.push('retry');
      return Promise.resolve();
    });
    render(
      <MemoryRouter>
        <AuthPolicyGate workspace={workspace} onRetry={onRetry} />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => {
      expect(calls).toEqual(['refresh', 'retry']);
    });
  });

  it('lists the allowed sign-in methods and offers to sign out', async () => {
    render(
      <MemoryRouter>
        <AuthPolicyGate
          workspace={methodRefused}
          onRetry={() => Promise.resolve()}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', {
        name: 'Engineering only allows signing in with Google or GitHub',
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Set up two-factor authentication' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Try again' })
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Sign out and sign in again' })
    );

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('starts the workspace connection, signs out, then leaves for the provider', async () => {
    render(
      <MemoryRouter initialEntries={['/w/engineering/issues']}>
        <AuthPolicyGate
          workspace={ssoRequired}
          onRetry={() => Promise.resolve()}
        />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', {
        name: 'Engineering requires single sign-on',
      })
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('auth-policy-sso'));

    await waitFor(() => {
      expect(calls).toEqual([
        'start',
        'logout',
        'assign https://login.example.com/authorize?state=s1',
      ]);
    });
    expect(startSsoSignIn).toHaveBeenCalledWith({
      connection_id: 'ws-1',
      return_to: '/login?returnTo=%2Fw%2Fengineering%2Fissues&sso_login=1',
    });
  });

  it('stays signed in and says so when the start is refused', async () => {
    startSsoSignIn.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError({
          status: 503,
          statusText: 'Service Unavailable',
          body: {
            success: false,
            message: 'Single sign-on is not available right now.',
            error_code: 'SSO_UNAVAILABLE',
          },
          url: '/api/auth/sso/start',
          method: 'POST',
        })
      )
    );
    render(
      <MemoryRouter>
        <AuthPolicyGate
          workspace={ssoRequired}
          onRetry={() => Promise.resolve()}
        />
      </MemoryRouter>
    );

    await userEvent.click(screen.getByTestId('auth-policy-sso'));

    expect(
      await screen.findByText('Single sign-on is not available right now.')
    ).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
