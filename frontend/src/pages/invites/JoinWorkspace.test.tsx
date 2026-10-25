/**
 * The invite link join page. A signed-out visitor is offered sign in and sign
 * up, both carrying a `returnTo` back to the link. Signed in, the page names
 * the workspace, joins on request and explains a dead link.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { InviteLinkPreview, MemberRead } from '../../types/Api';
import JoinWorkspace from './JoinWorkspace';

const previewInviteLink =
  vi.fn<(token: string) => Promise<InviteLinkPreview>>();
const joinInviteLink = vi.fn<(token: string) => Promise<MemberRead>>();

vi.mock('../../api/workspaces', () => ({
  previewInviteLink: (token: string) => previewInviteLink(token),
  joinInviteLink: (token: string) => joinInviteLink(token),
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

const PREVIEW: InviteLinkPreview = {
  workspace_id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  already_member: false,
};

const MEMBER: MemberRead = {
  user_id: 'user-1',
  email: 'someone@example.com',
  display_name: 'Someone',
  role: 'member',
  joined_at: '2026-10-20T00:00:00Z',
};

/** Mounts the page at `path`. */
const renderPage = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/join" element={<JoinWorkspace />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  previewInviteLink.mockReset();
  joinInviteLink.mockReset();
  useAuthMock.mockReset();
});

describe('JoinWorkspace', () => {
  it('asks for the link again when the token is missing', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderPage('/join');
    expect(screen.getByText(/missing its invite token/)).toBeInTheDocument();
    expect(previewInviteLink).not.toHaveBeenCalled();
  });

  it('offers sign in and sign up to a signed out visitor', () => {
    useAuthMock.mockReturnValue(session());
    renderPage('/join?token=tok-abc');
    const returnTo = encodeURIComponent('/join?token=tok-abc');
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/login?returnTo=${returnTo}`
    );
    expect(
      screen.getByRole('link', { name: 'Create an account' })
    ).toHaveAttribute('href', `/register?returnTo=${returnTo}`);
    expect(previewInviteLink).not.toHaveBeenCalled();
  });

  it('names the workspace and joins it', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    previewInviteLink.mockResolvedValue(PREVIEW);
    joinInviteLink.mockResolvedValue(MEMBER);
    const user = userEvent.setup();
    renderPage('/join?token=tok-abc');
    await user.click(await screen.findByRole('button', { name: 'Join Acme' }));
    expect(joinInviteLink).toHaveBeenCalledWith('tok-abc');
    expect(
      await screen.findByText('You have joined Acme.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open the workspace' })
    ).toHaveAttribute('href', '/w/acme');
  });

  it('points an existing member at the workspace', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    previewInviteLink.mockResolvedValue({ ...PREVIEW, already_member: true });
    renderPage('/join?token=tok-abc');
    expect(
      await screen.findByText('You are already a member of Acme.')
    ).toBeInTheDocument();
    expect(joinInviteLink).not.toHaveBeenCalled();
  });

  it('explains a dead link', async () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    previewInviteLink.mockRejectedValue(new Error('gone'));
    renderPage('/join?token=tok-abc');
    expect(
      await screen.findByText(/This invite link is not valid/)
    ).toBeInTheDocument();
  });
});
