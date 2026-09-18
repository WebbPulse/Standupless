/**
 * The invite redemption page. The load-bearing behaviour is the signed-out
 * round trip: the page is outside the protected routes, so a visitor following
 * an invite link is sent to login carrying a `returnTo` that brings the token
 * back, and the token is redeemed exactly once when they land.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { MemberRead, WorkspaceRead } from '../../types/Api';
import AcceptInvite from './AcceptInvite';

const listWorkspaces = vi.fn<() => Promise<WorkspaceRead[]>>();
const acceptInvite = vi.fn<(token: string) => Promise<MemberRead>>();

vi.mock('../../api/workspaces', () => ({
  listWorkspaces: () => listWorkspaces(),
  acceptInvite: (token: string) => acceptInvite(token),
}));

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

/** A session value with every flag defaulted to a settled signed-out one. */
const session = (
  overrides: Partial<AuthContextType> = {}
): AuthContextType => ({
  isAuthenticated: false,
  isLoading: false,
  isBusy: false,
  user: null,
  login: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  checkAuthStatus: vi.fn(() => Promise.resolve()),
  ...overrides,
});

/** One workspace row as the list route answers it. */
const workspace = (id: string, slug: string): WorkspaceRead => ({
  id,
  name: slug === 'joined' ? 'Joined' : 'Existing',
  slug,
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'member',
});

/** The member row the accept route answers with. */
const member: MemberRead = {
  user_id: 'user-1',
  email: 'someone@example.com',
  display_name: 'Someone',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
};

/** Reports the path the router settled on, so a redirect can be asserted. */
const LoginProbe = () => {
  const location = useLocation();
  return <p>{`login ${location.search}`}</p>;
};

/** Mounts the page at `path` with a login route to be redirected onto. */
const renderPage = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/invites/accept" element={<AcceptInvite />} />
        <Route path="/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listWorkspaces.mockReset();
  acceptInvite.mockReset();
  useAuthMock.mockReset();
});

describe('AcceptInvite', () => {
  it('asks for the link again when the token is missing', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderPage('/invites/accept');

    expect(screen.getByText(/missing its invite token/)).toBeInTheDocument();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('waits rather than redirecting while the session is still settling', () => {
    useAuthMock.mockReturnValue(session({ isLoading: true }));
    renderPage('/invites/accept?token=tok-abc');

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText(/^login /)).not.toBeInTheDocument();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('sends a signed out visitor to login with a returnTo carrying the token', () => {
    useAuthMock.mockReturnValue(session());
    renderPage('/invites/accept?token=tok-abc');

    expect(
      screen.getByText(
        `login ?returnTo=${encodeURIComponent('/invites/accept?token=tok-abc')}`
      )
    ).toBeInTheDocument();
    expect(acceptInvite).not.toHaveBeenCalled();
  });

  it('redeems the token and points at the workspace that appeared', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    acceptInvite.mockResolvedValue(member);
    listWorkspaces
      .mockResolvedValueOnce([workspace('ws-old', 'existing')])
      .mockResolvedValueOnce([
        workspace('ws-old', 'existing'),
        workspace('ws-new', 'joined'),
      ]);
    renderPage('/invites/accept?token=tok-abc');

    expect(
      await screen.findByText(/You have joined Joined/)
    ).toBeInTheDocument();
    expect(acceptInvite).toHaveBeenCalledWith('tok-abc');
    expect(
      screen.getByRole('link', { name: 'Open the workspace' })
    ).toHaveAttribute('href', '/w/joined');
  });

  it('redeems the token only once', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    acceptInvite.mockResolvedValue(member);
    listWorkspaces.mockResolvedValue([]);
    const { rerender } = renderPage('/invites/accept?token=tok-abc');

    await screen.findByText(/You have joined/);
    rerender(
      <MemoryRouter initialEntries={['/invites/accept?token=tok-abc']}>
        <Routes>
          <Route path="/invites/accept" element={<AcceptInvite />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(acceptInvite).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back to the workspace list when no new workspace can be told apart', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    acceptInvite.mockResolvedValue(member);
    listWorkspaces.mockResolvedValue([workspace('ws-old', 'existing')]);
    renderPage('/invites/accept?token=tok-abc');

    expect(
      await screen.findByText(/You have joined the workspace/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Go to your workspaces' })
    ).toHaveAttribute('href', '/workspaces');
  });

  it('explains a token that is expired or already spent', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    listWorkspaces.mockResolvedValue([]);
    acceptInvite.mockRejectedValue(new Error('gone'));
    renderPage('/invites/accept?token=tok-abc');

    expect(
      await screen.findByText(/That invite could not be accepted/)
    ).toBeInTheDocument();
  });
});
