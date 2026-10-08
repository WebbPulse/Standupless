/**
 * The workspace security page. An admin with their own authenticator app turns
 * the two-factor requirement on; the switch is held off below Business or
 * without the admin's own factor, says why, and turning it off always works.
 * Anyone below admin is told they cannot change it.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  AuthPolicyRead,
  AuthPolicyUpdate,
  UserRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import SecuritySettings from './SecuritySettings';

const getAuthPolicy = vi.fn<() => Promise<AuthPolicyRead>>();
const updateAuthPolicy =
  vi.fn<(body: AuthPolicyUpdate) => Promise<AuthPolicyRead>>();
let currentUser: UserRead | null = null;

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: currentUser,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/workspaces', () => ({
  getAuthPolicy: () => getAuthPolicy(),
  updateAuthPolicy: (_workspaceId: string, body: AuthPolicyUpdate) =>
    updateAuthPolicy(body),
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'engineering',
    plan: 'business',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** The signed in admin, with or without their own second factor. */
const user = (twoFactor: boolean): UserRead => ({
  id: 'user-1',
  email: 'admin@example.com',
  display_name: 'Admin',
  email_verified: true,
  two_factor: twoFactor,
});

/** The policy in the shape the contract answers with. */
const policy = (over: Partial<AuthPolicyRead> = {}): AuthPolicyRead => ({
  require_two_factor: false,
  updated_at: null,
  updated_by: null,
  available: true,
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <SecuritySettings />
    </MemoryRouter>
  );

beforeEach(() => {
  getAuthPolicy.mockReset();
  updateAuthPolicy.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('admin'));
  currentUser = user(true);
  getAuthPolicy.mockResolvedValue(policy());
});

describe('the workspace security page', () => {
  it('turns the two-factor requirement on for an admin with their own factor', async () => {
    updateAuthPolicy.mockResolvedValue(policy({ require_two_factor: true }));
    renderPage();

    const toggle = await screen.findByRole('switch', {
      name: 'Require two-factor authentication',
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeEnabled();

    getAuthPolicy.mockResolvedValue(policy({ require_two_factor: true }));
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(updateAuthPolicy).toHaveBeenCalledWith({
        require_two_factor: true,
      });
    });
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('holds the switch off until the admin sets up their own factor', async () => {
    currentUser = user(false);
    renderPage();

    const toggle = await screen.findByRole('switch', {
      name: 'Require two-factor authentication',
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/Set up an authenticator app on your own account/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Account security' })
    ).toHaveAttribute('href', '/security');
  });

  it('points below Business at the plans', async () => {
    getAuthPolicy.mockResolvedValue(policy({ available: false }));
    renderPage();

    const toggle = await screen.findByRole('switch', {
      name: 'Require two-factor authentication',
    });
    expect(toggle).toBeDisabled();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/w/engineering/settings/billing'
    );
  });

  it('always lets an admin turn the requirement off', async () => {
    currentUser = user(false);
    getAuthPolicy.mockResolvedValue(
      policy({ require_two_factor: true, available: false })
    );
    updateAuthPolicy.mockResolvedValue(policy({ available: false }));
    renderPage();

    const toggle = await screen.findByRole('switch', {
      name: 'Require two-factor authentication',
    });
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);

    await waitFor(() => {
      expect(updateAuthPolicy).toHaveBeenCalledWith({
        require_two_factor: false,
      });
    });
  });

  it('tells a member they cannot change it', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      screen.getByText(
        'Only workspace owners and admins can change security settings.'
      )
    ).toBeInTheDocument();
    expect(getAuthPolicy).not.toHaveBeenCalled();
  });
});
