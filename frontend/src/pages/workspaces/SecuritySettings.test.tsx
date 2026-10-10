/**
 * The workspace security page. An admin with their own second factor turns
 * the two-factor requirement on; the switch is held off below Business or
 * without the admin's own factor, says why, and turning it off always works.
 * Anyone below admin is told they cannot change it. The allowed sign-in methods
 * keep the admin's own method and the last one ticked, and below Business only
 * re-ticking works. The approved domains
 * section offers the admin's own verified domain and removes approved ones.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ApprovedDomainRead,
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
const listApprovedDomains = vi.fn<() => Promise<ApprovedDomainRead[]>>();
const addApprovedDomain =
  vi.fn<(domain: string) => Promise<ApprovedDomainRead>>();
const removeApprovedDomain = vi.fn<(domain: string) => Promise<void>>();
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
  listApprovedDomains: () => listApprovedDomains(),
  addApprovedDomain: (_workspaceId: string, domain: string) =>
    addApprovedDomain(domain),
  removeApprovedDomain: (_workspaceId: string, domain: string) =>
    removeApprovedDomain(domain),
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
  allowed_methods: ['password', 'google', 'github', 'passkey'],
  updated_at: null,
  updated_by: null,
  available: true,
  current_method: 'password',
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
  listApprovedDomains.mockReset();
  addApprovedDomain.mockReset();
  removeApprovedDomain.mockReset();
  listApprovedDomains.mockResolvedValue([]);
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
      screen.getByText(
        /Add an authenticator app or a passkey to your own account/
      )
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
    for (const link of screen.getAllByRole('link', { name: 'View plans' })) {
      expect(link).toHaveAttribute('href', '/w/engineering/settings/billing');
    }
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
    expect(listApprovedDomains).not.toHaveBeenCalled();
  });
});

describe('the allowed sign-in methods', () => {
  it('stops allowing a method the admin did not sign in with', async () => {
    updateAuthPolicy.mockResolvedValue(
      policy({ allowed_methods: ['password', 'google', 'passkey'] })
    );
    renderPage();

    const github = await screen.findByRole('checkbox', { name: 'GitHub' });
    expect(github).toBeChecked();
    expect(github).toBeEnabled();

    getAuthPolicy.mockResolvedValue(
      policy({ allowed_methods: ['password', 'google', 'passkey'] })
    );
    await userEvent.click(github);

    await waitFor(() => {
      expect(updateAuthPolicy).toHaveBeenCalledWith({
        allowed_methods: ['password', 'google', 'passkey'],
      });
    });
    await waitFor(() => {
      expect(github).not.toBeChecked();
    });
  });

  it("keeps the admin's own method allowed", async () => {
    getAuthPolicy.mockResolvedValue(policy({ current_method: 'google' }));
    renderPage();

    const google = await screen.findByRole('checkbox', { name: 'Google' });
    expect(google).toBeDisabled();
    expect(
      screen.getByText('You signed in with Google, so it stays allowed.')
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Password' })).toBeEnabled();
  });

  it('keeps the last allowed method', async () => {
    getAuthPolicy.mockResolvedValue(
      policy({ allowed_methods: ['password'], current_method: 'password' })
    );
    renderPage();

    expect(
      await screen.findByRole('checkbox', { name: 'Password' })
    ).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Google' })).not.toBeChecked();
  });

  it('lets a workspace below Business allow a method again but not restrict one', async () => {
    getAuthPolicy.mockResolvedValue(
      policy({
        available: false,
        allowed_methods: ['password', 'google', 'passkey'],
      })
    );
    updateAuthPolicy.mockResolvedValue(policy({ available: false }));
    renderPage();

    const github = await screen.findByRole('checkbox', { name: 'GitHub' });
    expect(screen.getByRole('checkbox', { name: 'Google' })).toBeDisabled();
    expect(github).toBeEnabled();
    await userEvent.click(github);

    await waitFor(() => {
      expect(updateAuthPolicy).toHaveBeenCalledWith({
        allowed_methods: ['password', 'google', 'github', 'passkey'],
      });
    });
  });
});

describe('the approved email domains section', () => {
  const approved: ApprovedDomainRead = {
    domain: 'example.com',
    added_by: 'user-1',
    added_at: '2026-10-01T00:00:00Z',
  };

  it("approves the admin's own verified domain", async () => {
    addApprovedDomain.mockResolvedValue(approved);
    renderPage();

    expect(
      await screen.findByText(
        'No approved domains. Members join by invite only.'
      )
    ).toBeInTheDocument();
    listApprovedDomains.mockResolvedValue([approved]);
    await userEvent.click(
      screen.getByRole('button', { name: 'Approve example.com' })
    );

    await waitFor(() => {
      expect(addApprovedDomain).toHaveBeenCalledWith('example.com');
    });
    expect(
      await screen.findByRole('button', { name: 'Remove example.com' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Approve example.com' })
    ).not.toBeInTheDocument();
  });

  it('removes an approved domain', async () => {
    listApprovedDomains.mockResolvedValue([approved]);
    removeApprovedDomain.mockResolvedValue(undefined);
    renderPage();

    const remove = await screen.findByRole('button', {
      name: 'Remove example.com',
    });
    listApprovedDomains.mockResolvedValue([]);
    await userEvent.click(remove);

    await waitFor(() => {
      expect(removeApprovedDomain).toHaveBeenCalledWith('example.com');
    });
    expect(
      await screen.findByText(
        'No approved domains. Members join by invite only.'
      )
    ).toBeInTheDocument();
  });

  it('asks an admin with an unverified email to verify it first', async () => {
    currentUser = { ...user(true), email_verified: false };
    renderPage();

    expect(
      await screen.findByRole('link', { name: 'Verify your email' })
    ).toHaveAttribute('href', '/verify-email');
    expect(
      screen.queryByRole('button', { name: /^Approve/ })
    ).not.toBeInTheDocument();
  });
});
