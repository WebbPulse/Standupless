/**
 * The share link settings page. What matters here is that the page is a list
 * and a revoke and nothing else: a link is minted from the thing it points at,
 * and the rows carry the hash rather than the token, so the page must never
 * render a token and must revoke by hash.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ShareLinkRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ShareLinksSettings from './ShareLinksSettings';

const listShareLinks = vi.fn<(query: unknown) => Promise<ShareLinkRead[]>>();
const revokeShareLink = vi.fn<(tokenHash: string) => Promise<void>>();

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
  listShareLinks: (_workspaceId: string, query: unknown) =>
    listShareLinks(query),
  revokeShareLink: (_workspaceId: string, tokenHash: string) =>
    revokeShareLink(tokenHash),
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

/** One link row in the shape the contract answers with. */
const link = (over: Partial<ShareLinkRead> = {}): ShareLinkRead => ({
  token_hash: 'hash-1',
  target_type: 'issue',
  target_id: 'iss-1',
  project_id: 'proj-1',
  title: 'Boot the engine',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: null,
  url: 'https://standupless.dev/shared',
  ...over,
});

/** Mounts the page inside a router, which the shell and section nav require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <ShareLinksSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listShareLinks.mockReset();
  revokeShareLink.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  listShareLinks.mockResolvedValue([link()]);
  revokeShareLink.mockResolvedValue(undefined);
});

describe('the share link list', () => {
  it('renders a link by its title, target type and state', async () => {
    renderPage();

    expect(await screen.findByText('Boot the engine')).toBeInTheDocument();
    expect(screen.getByText('Issue, Active')).toBeInTheDocument();
    expect(screen.getByText(/expires never/)).toBeInTheDocument();
  });

  it('renders a view share as a view', async () => {
    listShareLinks.mockResolvedValue([
      link({ target_type: 'view', title: 'This sprint' }),
    ]);
    renderPage();

    expect(await screen.findByText('View, Active')).toBeInTheDocument();
  });

  it('calls a past expiry expired', async () => {
    listShareLinks.mockResolvedValue([
      link({ expires_at: '2020-01-01T00:00:00Z' }),
    ]);
    renderPage();

    expect(await screen.findByText('Issue, Expired')).toBeInTheDocument();
  });

  it('never renders a token, since the list is not a credential', async () => {
    renderPage();

    await screen.findByText('Boot the engine');
    expect(screen.queryByText(/hash-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/shared\/shr_/)).not.toBeInTheDocument();
  });

  it('offers no way to create one, because that happens at the target', async () => {
    renderPage();

    await screen.findByText('Boot the engine');
    expect(
      screen.queryByRole('button', { name: /Create|Share|Mint/ })
    ).not.toBeInTheDocument();
  });

  it('says so when nothing is shared', async () => {
    listShareLinks.mockResolvedValue([]);
    renderPage();

    expect(
      await screen.findByText('Nothing in this workspace is shared publicly.')
    ).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listShareLinks.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load the share links.')
    ).toBeInTheDocument();
  });

  it('sends no target filter until one is chosen', async () => {
    renderPage();

    await screen.findByText('Boot the engine');
    expect(listShareLinks).toHaveBeenCalledWith({});
  });

  it('narrows the read to one target type', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Show'), 'view');

    await waitFor(() => {
      expect(listShareLinks).toHaveBeenCalledWith({ target_type: 'view' });
    });
  });
});

describe('revoking a share link', () => {
  it('names the token hash rather than the token', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(revokeShareLink).toHaveBeenCalledWith('hash-1');
    });
  });

  it('surfaces a refused revoke', async () => {
    revokeShareLink.mockRejectedValue(new Error('not yours'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    expect(
      await screen.findByText('Could not revoke that link.')
    ).toBeInTheDocument();
  });
});
