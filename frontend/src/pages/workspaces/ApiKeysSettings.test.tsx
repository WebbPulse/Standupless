/**
 * The API key settings page. The behaviour worth pinning is the secret: it
 * comes back from the mint and from nothing else, so the page must surface it
 * exactly once and the list must never carry it. Also covers that the
 * workspace-wide listing and the workspace key kind are offered only to an
 * admin, which is what the server allows, and that a revoke names the key id.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ApiKeyCreatedRead,
  ApiKeyRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ApiKeysSettings from './ApiKeysSettings';

const listApiKeys = vi.fn<(query: unknown) => Promise<ApiKeyRead[]>>();
const createApiKey = vi.fn<(body: unknown) => Promise<ApiKeyCreatedRead>>();
const revokeApiKey = vi.fn<(keyId: string) => Promise<void>>();

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

vi.mock('../../api/access', () => ({
  listApiKeys: (_workspaceId: string, query: unknown) => listApiKeys(query),
  createApiKey: (_workspaceId: string, body: unknown) => createApiKey(body),
  revokeApiKey: (_workspaceId: string, keyId: string) => revokeApiKey(keyId),
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

/** One key row in the shape the contract answers with. */
const key = (over: Partial<ApiKeyRead> = {}): ApiKeyRead => ({
  key_id: 'key-1',
  name: 'Shell',
  kind: 'user',
  prefix: 'wpk_abcd1234',
  scopes: ['issues:read', 'teams:read'],
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <ApiKeysSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listApiKeys.mockReset();
  createApiKey.mockReset();
  revokeApiKey.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
  listApiKeys.mockResolvedValue([key()]);
  createApiKey.mockResolvedValue({
    ...key({ key_id: 'key-2', name: 'CI' }),
    secret: 'wpk_plaintext',
  });
  revokeApiKey.mockResolvedValue(undefined);
});

describe('the API key list', () => {
  it('renders a key by its name, kind, prefix and scopes', async () => {
    renderPage();

    expect(await screen.findByText('Shell')).toBeInTheDocument();
    expect(screen.getByText('Personal key')).toBeInTheDocument();
    expect(screen.getByText('wpk_abcd1234')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('issues:read, teams:read')).toBeInTheDocument();
  });

  it('never carries a secret in the list', async () => {
    renderPage();

    await screen.findByText('Shell');
    expect(screen.queryByText(/wpk_plaintext/)).not.toBeInTheDocument();
  });

  it('says a revoked key is revoked rather than hiding it', async () => {
    listApiKeys.mockResolvedValue([
      key({ revoked_at: '2026-09-18T02:00:00Z' }),
    ]);
    renderPage();

    expect(await screen.findByText('wpk_abcd1234')).toBeInTheDocument();
    expect(screen.getByText('Personal key')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke' })
    ).not.toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    listApiKeys.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText('There are no API keys yet.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listApiKeys.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load the API keys.')
    ).toBeInTheDocument();
  });
});

describe('the workspace listing gate', () => {
  it('offers the workspace-wide listing to an admin', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    renderPage();

    await screen.findByText('Shell');
    expect(screen.getByLabelText('Show')).toBeInTheDocument();
    expect(listApiKeys).toHaveBeenCalledWith({ scope: 'mine' });
  });

  it('withholds it from a member, whose read the server would refuse', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    await screen.findByText('Shell');
    expect(screen.queryByLabelText('Show')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Kind')).not.toBeInTheDocument();
  });

  it('re-reads under the workspace scope when an admin asks for it', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Show'), 'workspace');

    await waitFor(() => {
      expect(listApiKeys).toHaveBeenCalledWith({ scope: 'workspace' });
    });
  });
});

describe('minting a key', () => {
  it('sends the name and the checked scopes', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.click(screen.getByLabelText('issues:write'));
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    await waitFor(() => {
      expect(createApiKey).toHaveBeenCalledWith({
        name: 'CI',
        scopes: ['issues:read', 'issues:write'],
      });
    });
  });

  it('sends the workspace kind when an admin picks it', async () => {
    const user = userEvent.setup();
    renderPage();

    createApiKey.mockResolvedValue({
      ...key({ key_id: 'key-2', name: 'Service' }),
      secret: 'wpk_plaintext',
    });
    await user.type(await screen.findByLabelText('Name'), 'Service');
    await user.selectOptions(screen.getByLabelText('Kind'), 'workspace');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    await waitFor(() => {
      expect(createApiKey).toHaveBeenCalledWith({
        name: 'Service',
        scopes: ['issues:read'],
        kind: 'workspace',
      });
    });
  });

  it('sends the expiry when one is given', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.type(screen.getByLabelText(/Expires in days/), '30');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    await waitFor(() => {
      expect(createApiKey).toHaveBeenCalledWith({
        name: 'CI',
        scopes: ['issues:read'],
        expires_in_days: 30,
      });
    });
  });

  it('bounds the expiry box at the range the contract accepts', async () => {
    renderPage();

    const box = await screen.findByLabelText(/Expires in days/);
    expect(box).toHaveAttribute('min', '1');
    expect(box).toHaveAttribute('max', '365');
  });

  it('leaves the expiry out entirely when the box is blank', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    await waitFor(() => {
      expect(createApiKey).toHaveBeenCalledWith({
        name: 'CI',
        scopes: ['issues:read'],
      });
    });
  });

  it('shows the secret once and then not at all', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(await screen.findByText('wpk_plaintext')).toBeInTheDocument();
    expect(
      screen.getByText(/only time the key for CI is shown/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('wpk_plaintext')).not.toBeInTheDocument();
  });

  it('copies the secret to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));
    await user.click(await screen.findByRole('button', { name: 'Copy key' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('wpk_plaintext');
    });
  });

  it('refuses to submit with no scope checked', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.click(screen.getByLabelText('issues:read'));

    expect(screen.getByRole('button', { name: 'Mint key' })).toBeDisabled();
  });

  it('surfaces a refused mint', async () => {
    createApiKey.mockRejectedValue(new Error('at the limit'));
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Name'), 'CI');
    await user.click(screen.getByRole('button', { name: 'Mint key' }));

    expect(
      await screen.findByText('Could not mint the key.')
    ).toBeInTheDocument();
  });
});

describe('revoking a key', () => {
  it('names the key id', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(revokeApiKey).toHaveBeenCalledWith('key-1');
    });
  });

  it('surfaces a refused revoke', async () => {
    revokeApiKey.mockRejectedValue(new Error('not yours'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(
      await screen.findByText('Could not revoke that key.')
    ).toBeInTheDocument();
  });
});
