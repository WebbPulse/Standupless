/**
 * After a sign in, the login page returns to an MCP authorize URL on the API
 * origin with a full page load, and to anything else only as a local path.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';

const login = vi.fn();
const seedUser = vi.fn();
const assign = vi.fn();

vi.mock('@webbpulse/auth/react', () => ({
  useAuth: () => ({ login, completeTotp: vi.fn() }),
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
});
