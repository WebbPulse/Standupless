/**
 * After a sign in, the login page returns to an MCP authorize URL on the API
 * origin with a full page load, and to anything else only as a local path.
 * Its second leg takes a TOTP code or a passkey, whichever the challenge lists.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

const login = vi.fn();
const completeTotp = vi.fn();
const completeMfaWithPasskey = vi.fn();
const seedUser = vi.fn();
const assign = vi.fn();

vi.mock('@webbpulse/auth/react', () => ({
  useAuth: () => ({ login, completeTotp, completeMfaWithPasskey }),
  useOAuthCallback: () => undefined,
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    login: seedUser,
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => null,
  identityOrigin: () => 'https://api.standupless.dev',
}));

vi.mock('../../components/auth/PasskeySignInButton', () => ({
  default: () => null,
}));

vi.mock('../../components/auth/OAuthProviderButtons', () => ({
  default: ({ returnTo }: { returnTo?: string }) => (
    <p data-testid="oauth-return">{returnTo}</p>
  ),
}));

const AUTHORIZE =
  'https://api.standupless.dev/api/auth/authorize?response_type=code&client_id=abc';

/** Mounts the login page at `path` with a workspaces page to land on. */
const renderLogin = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/workspaces" element={<p>workspaces page</p>} />
      </Routes>
    </MemoryRouter>
  );

/** Fills and submits the password form. */
const signIn = () => {
  fireEvent.change(screen.getByTestId('login-email'), {
    target: { value: 'person@example.com' },
  });
  fireEvent.change(screen.getByTestId('login-password'), {
    target: { value: 'correct horse' },
  });
  fireEvent.submit(screen.getByTestId('login-email').closest('form')!);
};

beforeEach(() => {
  login.mockReset();
  login.mockResolvedValue({ mfaRequired: false, user: { id: 'u1' } });
  completeTotp.mockReset();
  completeMfaWithPasskey.mockReset();
  assign.mockReset();
  vi.stubGlobal('location', { assign });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Login', () => {
  it('returns to an MCP authorize URL after a password sign in', async () => {
    renderLogin(`/login?returnTo=${encodeURIComponent(AUTHORIZE)}`);
    signIn();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
  });

  it('routes a provider sign in back through the login page', () => {
    renderLogin(`/login?returnTo=${encodeURIComponent(AUTHORIZE)}`);

    expect(screen.getByTestId('oauth-return')).toHaveTextContent(
      `/login?returnTo=${encodeURIComponent(AUTHORIZE)}`
    );
  });

  it('never leaves the site for an authorize URL on another origin', async () => {
    renderLogin(
      `/login?returnTo=${encodeURIComponent('https://evil.example.com/api/auth/authorize')}`
    );
    signIn();

    expect(await screen.findByText('workspaces page')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it.each(['//evil.example', '/\\evil.example'])(
    'refuses the off-site returnTo %s',
    async (returnTo) => {
      renderLogin(`/login?returnTo=${encodeURIComponent(returnTo)}`);

      expect(screen.getByTestId('oauth-return')).toHaveTextContent(
        '/workspaces'
      );
      signIn();

      expect(await screen.findByText('workspaces page')).toBeInTheDocument();
      expect(assign).not.toHaveBeenCalled();
    }
  );
});

describe('Login second leg', () => {
  /** Signs in with a password that the server answers with a challenge. */
  const challenge = (factors: string[]) => {
    login.mockResolvedValue({ mfaRequired: true, ticket: 't1', factors });
    renderLogin('/login');
    signIn();
  };

  it('offers a passkey next to the code when the challenge lists both', async () => {
    challenge(['totp', 'passkey']);

    expect(await screen.findByTestId('login-code')).toBeInTheDocument();
    expect(screen.getByTestId('login-mfa-passkey')).toHaveTextContent(
      'Use a passkey'
    );
  });

  it('asks only for a code when no passkey is registered', async () => {
    challenge(['totp']);

    expect(await screen.findByTestId('login-code')).toBeInTheDocument();
    expect(screen.queryByTestId('login-mfa-passkey')).not.toBeInTheDocument();
  });

  it('asks only for a passkey when the account has no authenticator app', async () => {
    challenge(['passkey']);

    expect(await screen.findByTestId('login-mfa-passkey')).toBeInTheDocument();
    expect(screen.queryByTestId('login-code')).not.toBeInTheDocument();
  });

  it('finishes the sign in when the passkey answers', async () => {
    completeMfaWithPasskey.mockResolvedValue({
      ok: true,
      kind: 'signed-in',
      user: { id: 'u1' },
      expiresIn: 900,
    });
    challenge(['totp', 'passkey']);

    fireEvent.click(await screen.findByTestId('login-mfa-passkey'));

    expect(await screen.findByText('workspaces page')).toBeInTheDocument();
    expect(completeMfaWithPasskey).toHaveBeenCalledWith({ ticket: 't1' });
    expect(seedUser).toHaveBeenCalledWith({ id: 'u1' });
  });

  it('says so when the passkey prompt is closed and keeps the code open', async () => {
    completeMfaWithPasskey.mockResolvedValue({
      ok: false,
      reason: 'cancelled',
      message: 'cancelled',
    });
    challenge(['totp', 'passkey']);

    fireEvent.click(await screen.findByTestId('login-mfa-passkey'));

    expect(
      await screen.findByText(
        'The passkey prompt was closed. Try again or enter a code instead.'
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('login-code')).toBeInTheDocument();
  });

  it('returns to the password form when the attempt has expired', async () => {
    completeMfaWithPasskey.mockResolvedValue({
      ok: false,
      reason: 'ticket-invalid',
      message: 'expired',
    });
    challenge(['passkey']);

    fireEvent.click(await screen.findByTestId('login-mfa-passkey'));

    expect(
      await screen.findByText('That sign-in attempt has expired. Sign in again.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('login-email')).toBeInTheDocument();
  });
});
