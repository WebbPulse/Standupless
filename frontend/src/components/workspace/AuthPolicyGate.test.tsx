/**
 * The auth policy gate: for a missing second factor it names the workspace,
 * links to account security, and "Try again" refreshes the session before
 * re-reading the workspace list. For a refused sign-in method it lists the
 * allowed methods and offers to sign out.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRead } from '../../types/Api';
import AuthPolicyGate from './AuthPolicyGate';

const calls: string[] = [];
const logout = vi.fn(() => Promise.resolve());
const refresh = vi.fn(() => {
  calls.push('refresh');
  return Promise.resolve('token');
});

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({ refresh }),
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

beforeEach(() => {
  calls.length = 0;
  refresh.mockClear();
  logout.mockClear();
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
});
