/**
 * The auth policy gate: it names the workspace, links to account security,
 * and "Try again" refreshes the session before re-reading the workspace list.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRead } from '../../types/Api';
import AuthPolicyGate from './AuthPolicyGate';

const calls: string[] = [];
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
    logout: vi.fn(),
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
};

beforeEach(() => {
  calls.length = 0;
  refresh.mockClear();
});

describe('the auth policy gate', () => {
  it('explains the requirement and links to account security', () => {
    render(
      <MemoryRouter>
        <AuthPolicyGate workspace={workspace} onRetry={() => Promise.resolve()} />
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
});
