/**
 * The connected accounts panel: rows for the offered providers only, the
 * linked account or "Not connected", connect handing the browser to the
 * provider, disconnect behind a confirm, the step-up retry, the last sign-in
 * method refusal, and the callback flags turned into toasts.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StepUpRequiredError } from '@webbpulse/api-client';
import { AuthProvider, type AnyAuthClient } from '@webbpulse/auth/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, currentToasts } from '../../lib/toast';
import { accountLabel } from '../../lib/connectedAccounts';
import ConnectedAccountsPanel from './ConnectedAccountsPanel';

const listOAuthLinks = vi.fn<() => Promise<unknown>>();
const linkOAuthProvider =
  vi.fn<(provider: string, options: unknown) => Promise<unknown>>();
const unlinkOAuthProvider = vi.fn<(provider: string) => Promise<unknown>>();
const stepUp = vi.fn<(body: unknown) => Promise<unknown>>();
const stepUpWithPasskey = vi.fn<() => Promise<unknown>>();
let providers = [
  { id: 'github', displayName: 'GitHub' },
  { id: 'google', displayName: 'Google' },
];

const authState = { sessionEnded: null };

const fakeClient = {
  subscribe: () => () => undefined,
  getState: () => authState,
  initialize: () => Promise.resolve(),
  listOAuthLinks: () => listOAuthLinks(),
  linkOAuthProvider: (provider: string, options: unknown) =>
    linkOAuthProvider(provider, options),
  unlinkOAuthProvider: (provider: string) => unlinkOAuthProvider(provider),
  oauthStartUrl: (provider: string, options: { returnTo?: string }) =>
    `https://api.example.com/api/auth/oauth/${provider}/start?return_to=${options.returnTo ?? ''}`,
  stepUp: (body: unknown) => stepUp(body),
  stepUpWithPasskey: () => stepUpWithPasskey(),
};

vi.mock('../../api/identityClient', () => ({
  identityOrigin: () => 'https://api.example.com',
  getIdentityClient: () => fakeClient,
}));

vi.mock('@webbpulse/discovery/react', () => ({
  useOAuthProviders: () => providers,
}));

/** A step-up challenge as the client throws it. */
const stepUpError = (): StepUpRequiredError =>
  new StepUpRequiredError({
    status: 401,
    statusText: 'Unauthorized',
    body: { error_code: 'STEP_UP_REQUIRED', detail: 'Sign in again.' },
    url: 'https://api.example.com/api/auth/oauth/links/github',
    method: 'DELETE',
    maxAge: 600,
  });

/** The GitHub link as the list returns it. */
const githubLink = {
  provider: 'github',
  email: 'me@example.com',
  emailVerified: true,
  login: 'octocat',
  linkedAt: '2026-09-01T10:00:00Z',
  lastLoginAt: undefined,
};

/** Renders the panel at a URL, so callback flags can be given. */
const renderAt = (url = '/security') =>
  render(
    <AuthProvider
      client={fakeClient as unknown as AnyAuthClient}
      initializeOnMount={false}
    >
      <MemoryRouter initialEntries={[url]}>
        <ConnectedAccountsPanel />
      </MemoryRouter>
    </AuthProvider>
  );

const assign = vi.fn();
const reload = vi.fn();

beforeEach(() => {
  providers = [
    { id: 'github', displayName: 'GitHub' },
    { id: 'google', displayName: 'Google' },
  ];
  listOAuthLinks
    .mockReset()
    .mockResolvedValue({ ok: true, links: [githubLink] });
  linkOAuthProvider.mockReset();
  unlinkOAuthProvider.mockReset();
  stepUp.mockReset();
  stepUpWithPasskey.mockReset();
  assign.mockReset();
  reload.mockReset();
  vi.stubGlobal('location', { ...window.location, assign, reload });
  clearToasts();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accountLabel', () => {
  it('prefers the provider username', () => {
    expect(accountLabel(githubLink)).toBe('@octocat');
  });

  it('falls back to the provider email', () => {
    expect(
      accountLabel({
        provider: 'google',
        email: 'me@example.com',
        emailVerified: true,
        linkedAt: '2026-09-01T10:00:00Z',
        lastLoginAt: undefined,
      })
    ).toBe('me@example.com');
  });
});

describe('ConnectedAccountsPanel', () => {
  it('lists each offered provider with its account or Not connected', async () => {
    renderAt();
    const github = await screen.findByTestId('connected-account-github');
    expect(within(github).getByText(/@octocat/)).toBeInTheDocument();
    const google = screen.getByTestId('connected-account-google');
    expect(within(google).getByText('Not connected')).toBeInTheDocument();
    expect(
      within(google).getByRole('button', { name: 'Connect Google' })
    ).toBeInTheDocument();
  });

  it('renders nothing when the deployment offers no provider', () => {
    providers = [];
    const { container } = renderAt();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only the providers this environment enables', async () => {
    providers = [{ id: 'github', displayName: 'GitHub' }];
    renderAt();
    await screen.findByTestId('connected-account-github');
    expect(screen.queryByTestId('connected-account-google')).toBeNull();
  });

  it('hands the browser to the provider on connect', async () => {
    linkOAuthProvider.mockResolvedValue({
      ok: true,
      authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?x=1',
    });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Google' })
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        'https://accounts.google.com/o/oauth2/auth?x=1'
      )
    );
    expect(linkOAuthProvider).toHaveBeenCalledWith('google', {
      returnTo: '/security',
    });
  });

  it('asks for a fresh sign in before connecting, then retries', async () => {
    linkOAuthProvider
      .mockRejectedValueOnce(stepUpError())
      .mockResolvedValueOnce({
        ok: true,
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
      });
    stepUp.mockResolvedValue({ ok: true });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Google' })
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText('Password'),
      'hunter2hunter2'
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Verify' })
    );
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(stepUp).toHaveBeenCalledWith({ password: 'hunter2hunter2' });
    expect(linkOAuthProvider).toHaveBeenCalledTimes(2);
    expect(linkOAuthProvider).toHaveBeenLastCalledWith('google', {
      returnTo: '/security',
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('asks for a fresh sign in before disconnecting, then retries the same unlink', async () => {
    unlinkOAuthProvider
      .mockRejectedValueOnce(stepUpError())
      .mockResolvedValueOnce({ ok: true });
    stepUp.mockResolvedValue({ ok: true });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect GitHub' })
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Disconnect',
      })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm it is you',
    });
    listOAuthLinks.mockResolvedValue({ ok: true, links: [] });
    await userEvent.type(
      within(dialog).getByLabelText('Password'),
      'hunter2hunter2'
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Verify' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(stepUp).toHaveBeenCalledWith({ password: 'hunter2hunter2' });
    expect(unlinkOAuthProvider).toHaveBeenCalledTimes(2);
    expect(unlinkOAuthProvider).toHaveBeenLastCalledWith('github');
    await waitFor(() =>
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'GitHub disconnected.'
      )
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows a refused connect as an error toast', async () => {
    linkOAuthProvider.mockResolvedValue({
      ok: false,
      reason: 'already-linked',
      code: 'OAUTH_ALREADY_LINKED',
      message: 'That account is already linked to another user.',
    });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Connect Google' })
    );
    await waitFor(() =>
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'That account is already linked to another user.'
      )
    );
    expect(assign).not.toHaveBeenCalled();
  });

  it('disconnects after the confirm and reloads the list', async () => {
    unlinkOAuthProvider.mockResolvedValue({ ok: true });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect GitHub' })
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/as @octocat/)).toBeInTheDocument();
    listOAuthLinks.mockResolvedValue({ ok: true, links: [] });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Disconnect' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(unlinkOAuthProvider).toHaveBeenCalledWith('github');
    await waitFor(() =>
      expect(
        within(screen.getByTestId('connected-account-github')).getByText(
          'Not connected'
        )
      ).toBeInTheDocument()
    );
    expect(currentToasts().map((toast) => toast.message)).toContain(
      'GitHub disconnected.'
    );
  });

  it('keeps the dialog open with the server sentence on the last sign-in method', async () => {
    unlinkOAuthProvider.mockResolvedValue({
      ok: false,
      reason: 'last-sign-in-method',
      code: 'OAUTH_LAST_SIGN_IN_METHOD',
      message: 'Set a password before disconnecting your only sign-in method.',
    });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect GitHub' })
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Disconnect' })
    );
    expect(
      await within(dialog).findByText(
        'Set a password before disconnecting your only sign-in method.'
      )
    ).toBeInTheDocument();
  });

  it('offers a passkey, a code and signing in again when a step-up is needed', async () => {
    unlinkOAuthProvider
      .mockRejectedValueOnce(stepUpError())
      .mockResolvedValueOnce({ ok: true });
    stepUpWithPasskey.mockResolvedValue({ ok: true });
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect GitHub' })
    );
    const confirm = await screen.findByRole('dialog');
    await userEvent.click(
      within(confirm).getByRole('button', { name: 'Disconnect' })
    );
    const reauth = await screen.findByRole('link', {
      name: 'Sign in again with GitHub',
    });
    expect(reauth).toHaveAttribute(
      'href',
      'https://api.example.com/api/auth/oauth/github/start?return_to=/security'
    );
    const dialog = screen.getByRole('dialog', { name: 'Confirm it is you' });
    expect(
      within(dialog).getByText(/Sign in again to disconnect GitHub/)
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', {
        name: 'Use an authenticator or recovery code instead',
      })
    );
    expect(
      within(dialog).getByLabelText('Authenticator or recovery code')
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Use a passkey' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(unlinkOAuthProvider).toHaveBeenCalledTimes(2);
  });

  it('turns a linked callback into a toast', async () => {
    renderAt('/security?oauth_linked=1');
    await waitFor(() =>
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'Account connected.'
      )
    );
  });

  it('closes the confirm when the step-up is cancelled', async () => {
    unlinkOAuthProvider.mockRejectedValueOnce(stepUpError());
    renderAt();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Disconnect GitHub' })
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Disconnect',
      })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Confirm it is you',
    });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(unlinkOAuthProvider).toHaveBeenCalledTimes(1);
  });

  it('turns a refused callback into an error toast', async () => {
    renderAt('/security?oauth_error=OAUTH_ALREADY_LINKED');
    await waitFor(() =>
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'That provider account is already linked to an account.'
      )
    );
  });

  it('reads the MFA ticket from the URL fragment', async () => {
    renderAt('/security#mfa_ticket=abc');
    await waitFor(() =>
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'That sign in needs your authenticator code. Confirm with the code instead.'
      )
    );
  });

  it('still reads a legacy MFA ticket from the query string', async () => {
    renderAt('/security?mfa_ticket=abc');
    await waitFor(() =>
      expect(currentToasts().map((toast) => toast.message)).toContain(
        'That sign in needs your authenticator code. Confirm with the code instead.'
      )
    );
  });
});
