/**
 * The email change confirmation page: it spends the token once, reports the
 * change, shows the server's sentence for a refused link, and needs a token.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VerifyEmailChange from './VerifyEmailChange';

const confirmEmailChange =
  vi.fn<(body: { token: string }) => Promise<unknown>>();
const checkAuthStatus = vi.fn(() => Promise.resolve());

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({
    confirmEmailChange: (body: { token: string }) => confirmEmailChange(body),
  }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: () => checkAuthStatus(),
  }),
}));

/** Mounts the page at the given address. */
const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <VerifyEmailChange />
    </MemoryRouter>
  );

beforeEach(() => {
  confirmEmailChange.mockReset();
  checkAuthStatus.mockClear();
});

describe('VerifyEmailChange', () => {
  it('spends the token once and confirms the change', async () => {
    confirmEmailChange.mockResolvedValue({ ok: true });
    renderAt('/verify-email-change?token=abc');

    expect(
      await screen.findByText(/Your sign-in email is changed/)
    ).toBeInTheDocument();
    expect(confirmEmailChange).toHaveBeenCalledTimes(1);
    expect(confirmEmailChange).toHaveBeenCalledWith({ token: 'abc' });
    await waitFor(() => expect(checkAuthStatus).toHaveBeenCalled());
  });

  it('shows the server sentence for a refused link', async () => {
    confirmEmailChange.mockResolvedValue({
      ok: false,
      reason: 'invalid-link',
      message: 'This link has expired.',
    });
    renderAt('/verify-email-change?token=old');

    expect(
      await screen.findByText('This link has expired.')
    ).toBeInTheDocument();
    expect(checkAuthStatus).not.toHaveBeenCalled();
  });

  it('falls back to its own sentence when the server sent none', async () => {
    confirmEmailChange.mockResolvedValue({
      ok: false,
      reason: 'invalid-link',
      message: '',
    });
    renderAt('/verify-email-change?token=old');

    expect(
      await screen.findByText(/This link is no longer valid/)
    ).toBeInTheDocument();
  });

  it('asks for a new link when the token is missing', () => {
    renderAt('/verify-email-change');

    expect(screen.getByText(/missing its token/)).toBeInTheDocument();
    expect(confirmEmailChange).not.toHaveBeenCalled();
  });
});
