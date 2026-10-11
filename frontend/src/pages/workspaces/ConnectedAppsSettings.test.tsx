/**
 * The connected apps settings page. Pins the empty state, that a revoke only
 * happens after the confirmation and names the client, that a refused revoke
 * keeps the dialog open with the reason, and that the workspace-wide list is
 * drawn only for an admin, which is what the server allows.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ConnectedAppRead,
  WorkspaceConnectedAppRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ConnectedAppsSettings from './ConnectedAppsSettings';

const listMyConnectedApps = vi.fn<() => Promise<ConnectedAppRead[]>>();
const revokeMyConnectedApp = vi.fn<(clientId: string) => Promise<void>>();
const grantMyConnectedAppScopes =
  vi.fn<(clientId: string, scopes: string[]) => Promise<ConnectedAppRead>>();
const listWorkspaceConnectedApps =
  vi.fn<(workspaceId: string) => Promise<WorkspaceConnectedAppRead[]>>();
const revokeWorkspaceConnectedApp =
  vi.fn<
    (workspaceId: string, userId: string, clientId: string) => Promise<void>
  >();

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

vi.mock('../../api/connectedApps', () => ({
  listMyConnectedApps: () => listMyConnectedApps(),
  revokeMyConnectedApp: (clientId: string) => revokeMyConnectedApp(clientId),
  grantMyConnectedAppScopes: (clientId: string, scopes: string[]) =>
    grantMyConnectedAppScopes(clientId, scopes),
  listWorkspaceConnectedApps: (workspaceId: string) =>
    listWorkspaceConnectedApps(workspaceId),
  revokeWorkspaceConnectedApp: (
    workspaceId: string,
    userId: string,
    clientId: string
  ) => revokeWorkspaceConnectedApp(workspaceId, userId, clientId),
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
    plan: 'free',
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

/** One of the caller's apps in the shape the contract answers with. */
const app = (over: Partial<ConnectedAppRead> = {}): ConnectedAppRead => ({
  client_id: 'mcp_claude',
  client_name: 'Claude',
  scopes: ['issues:read', 'issues:write'],
  first_authorized_at: '2026-09-20T00:00:00Z',
  last_used_at: '2026-09-25T00:00:00Z',
  workspaces: [
    {
      id: 'ws-1',
      name: 'Engineering',
      scopes: ['issues:read', 'issues:write'],
      authorized_at: '2026-09-20T00:00:00Z',
      last_used_at: '2026-09-25T00:00:00Z',
    },
  ],
  ...over,
});

/** One member grant in the shape the contract answers with. */
const memberGrant = (
  over: Partial<WorkspaceConnectedAppRead> = {}
): WorkspaceConnectedAppRead => ({
  client_id: 'mcp_cursor',
  client_name: 'Cursor',
  user: { id: 'user-2', display_name: 'Sam', email: 'sam@example.com' },
  scopes: ['issues:read'],
  authorized_at: '2026-09-21T00:00:00Z',
  last_used_at: null,
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <ConnectedAppsSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listMyConnectedApps.mockReset();
  revokeMyConnectedApp.mockReset();
  grantMyConnectedAppScopes.mockReset();
  listWorkspaceConnectedApps.mockReset();
  revokeWorkspaceConnectedApp.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  listMyConnectedApps.mockResolvedValue([app()]);
  revokeMyConnectedApp.mockResolvedValue(undefined);
  listWorkspaceConnectedApps.mockResolvedValue([memberGrant()]);
  revokeWorkspaceConnectedApp.mockResolvedValue(undefined);
});

describe('the caller connected apps', () => {
  it('renders an app with its workspaces and scopes', async () => {
    renderPage();

    const row = (await screen.findByText('Claude')).closest('li');
    expect(row).not.toBeNull();
    const scoped = within(row as HTMLElement);
    expect(scoped.getByText('Engineering', { exact: false })).toBeVisible();
    expect(scoped.getByText('issues:read, issues:write')).toBeInTheDocument();
  });

  it('offers no grant when the app holds every permission', async () => {
    renderPage();

    await screen.findByText('Claude');
    expect(
      screen.queryByRole('button', { name: 'Grant new permissions' })
    ).not.toBeInTheDocument();
  });

  it('grants the new permissions only after the confirmation', async () => {
    listMyConnectedApps.mockResolvedValue([
      app({ new_scopes: ['releases:read', 'releases:write'] }),
    ]);
    grantMyConnectedAppScopes.mockResolvedValue(app());
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText(/New permissions available/)
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Grant new permissions' })
    );
    expect(grantMyConnectedAppScopes).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', {
      name: 'Grant new permissions to Claude?',
    });
    expect(within(dialog).getByText('releases:write')).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: 'Grant permissions' })
    );

    await waitFor(() => {
      expect(grantMyConnectedAppScopes).toHaveBeenCalledWith('mcp_claude', [
        'releases:read',
        'releases:write',
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('shows the empty state when nothing is connected', async () => {
    listMyConnectedApps.mockResolvedValue([]);

    renderPage();

    expect(
      await screen.findByText(/No apps are connected to your account/)
    ).toBeInTheDocument();
  });

  it('revokes only after the confirmation', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(revokeMyConnectedApp).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog', {
      name: 'Revoke access for Claude?',
    });
    await user.click(
      within(dialog).getByRole('button', { name: 'Revoke access' })
    );

    await waitFor(() => {
      expect(revokeMyConnectedApp).toHaveBeenCalledWith('mcp_claude');
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('cancelling the confirmation revokes nothing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(revokeMyConnectedApp).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the reason when a revoke is refused', async () => {
    revokeMyConnectedApp.mockRejectedValue(new Error('Resource not found'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await user.click(screen.getByRole('button', { name: 'Revoke access' }));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  });
});

describe('the workspace connected apps', () => {
  it('is not drawn or read for a member', async () => {
    renderPage();

    await screen.findByText('Claude');
    expect(
      screen.queryByText('Connected apps in Engineering')
    ).not.toBeInTheDocument();
    expect(listWorkspaceConnectedApps).not.toHaveBeenCalled();
  });

  it('lists member grants for an admin and revokes one in this workspace', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText('Connected apps in Engineering')
    ).toBeInTheDocument();
    expect(await screen.findByText('Sam')).toBeInTheDocument();
    expect(screen.getByText('Never used')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Revoke Cursor for Sam' })
    );
    await user.click(screen.getByRole('button', { name: 'Revoke access' }));

    await waitFor(() => {
      expect(revokeWorkspaceConnectedApp).toHaveBeenCalledWith(
        'ws-1',
        'user-2',
        'mcp_cursor'
      );
    });
  });
});
