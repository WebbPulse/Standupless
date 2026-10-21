/**
 * The single sign-on section. Below Business it only points at the plans. An
 * admin adds a domain and sees its TXT record, saves an OIDC connection with
 * a refused field shown at that field, starts a test sign-in that signs out
 * first, records the test on its return, and cannot require single sign-on
 * until the workspace is ready and their own session came through it.
 */

import { ApiError } from '@webbpulse/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SsoConnectionRead,
  SsoConnectionUpdate,
  SsoDomainRead,
  SsoSettingsRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import SsoSection from './SsoSection';

const getSsoSettings = vi.fn<() => Promise<SsoSettingsRead>>();
const addSsoDomain = vi.fn<(domain: string) => Promise<SsoDomainRead>>();
const verifySsoDomain = vi.fn<(domain: string) => Promise<SsoDomainRead>>();
const removeSsoDomain = vi.fn<(domain: string) => Promise<void>>();
const saveSsoConnection =
  vi.fn<(body: SsoConnectionUpdate) => Promise<SsoSettingsRead>>();
const removeSsoConnection = vi.fn<() => Promise<void>>();
const recordSsoTestResult = vi.fn<() => Promise<SsoSettingsRead>>();
const updateSsoPolicy = vi.fn<(next: boolean) => Promise<SsoSettingsRead>>();
const beginSso = vi.fn<(options: unknown) => Promise<void>>();
const logout = vi.fn(() => Promise.resolve());

vi.mock('../../api/workspaces', () => ({
  getSsoSettings: () => getSsoSettings(),
  addSsoDomain: (_workspaceId: string, domain: string) => addSsoDomain(domain),
  verifySsoDomain: (_workspaceId: string, domain: string) =>
    verifySsoDomain(domain),
  removeSsoDomain: (_workspaceId: string, domain: string) =>
    removeSsoDomain(domain),
  saveSsoConnection: (_workspaceId: string, body: SsoConnectionUpdate) =>
    saveSsoConnection(body),
  removeSsoConnection: () => removeSsoConnection(),
  recordSsoTestResult: () => recordSsoTestResult(),
  updateSsoPolicy: (_workspaceId: string, next: boolean) =>
    updateSsoPolicy(next),
  joinSsoWorkspace: vi.fn(),
}));

vi.mock('../../lib/sso', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/sso')>('../../lib/sso');
  return {
    ...actual,
    beginSso: (options: unknown) => beginSso(options),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout,
    checkAuthStatus: vi.fn(),
  }),
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

/** The workspace with the caller holding `role`. */
const workspace = (role: WorkspaceRole = 'admin'): WorkspaceRead => ({
  id: 'ws-1',
  name: 'Engineering',
  slug: 'engineering',
  plan: 'business',
  created_at: '2026-09-17T00:00:00Z',
  role,
});

/** A domain row in the shape the contract answers with. */
const domain = (over: Partial<SsoDomainRead> = {}): SsoDomainRead => ({
  domain: 'example.com',
  verified: false,
  verified_at: null,
  added_at: '2026-10-16T00:00:00Z',
  record_name: '_standupless-sso.example.com',
  record_type: 'TXT',
  record_value: 'standupless-sso=abc123',
  ...over,
});

/** A stored OIDC connection. */
const connection = (
  over: Partial<SsoConnectionRead> = {}
): SsoConnectionRead => ({
  protocol: 'oidc',
  display_name: 'Okta',
  oidc_issuer: 'https://login.example.com',
  oidc_client_id: 'client-1',
  oidc_scopes: ['openid', 'email', 'profile'],
  has_client_secret: true,
  saml_idp_entity_id: '',
  saml_idp_sso_url: '',
  saml_certificate_count: 0,
  tested: false,
  tested_at: null,
  updated_at: '2026-10-16T00:00:00Z',
  ...over,
});

/** The settings in the shape the contract answers with. */
const settings = (over: Partial<SsoSettingsRead> = {}): SsoSettingsRead => ({
  available: true,
  domains: [],
  connection: null,
  require_sso: false,
  service_provider: {
    oidc_redirect_uri: 'https://id.example.test/sso/oidc/callback',
    saml_acs_url: 'https://id.example.test/sso/saml/acs',
    saml_metadata_url: 'https://id.example.test/sso/saml/metadata',
    saml_entity_id: 'https://id.example.test/sso/saml',
  },
  current_session_sso: false,
  can_require: false,
  ...over,
});

/** Mounts the section at `entry`, inside a router. */
const renderSection = (
  role: WorkspaceRole = 'admin',
  entry = '/w/engineering/settings/security'
) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <SsoSection workspace={workspace(role)} />
    </MemoryRouter>
  );

beforeEach(() => {
  for (const mock of [
    getSsoSettings,
    addSsoDomain,
    verifySsoDomain,
    removeSsoDomain,
    saveSsoConnection,
    removeSsoConnection,
    recordSsoTestResult,
    updateSsoPolicy,
    beginSso,
  ]) {
    mock.mockReset();
  }
  logout.mockClear();
  getSsoSettings.mockResolvedValue(settings());
  beginSso.mockResolvedValue(undefined);
});

describe('the single sign-on section', () => {
  it('points at the plans below Business', async () => {
    getSsoSettings.mockResolvedValue(settings({ available: false }));
    renderSection();

    expect(
      await screen.findByText(/Available on the Business plan/)
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View plans' })).toHaveAttribute(
      'href',
      '/w/engineering/settings/billing'
    );
    expect(
      screen.queryByRole('switch', { name: 'Require single sign-on' })
    ).not.toBeInTheDocument();
  });

  it('adds a domain and shows the TXT record to publish', async () => {
    addSsoDomain.mockResolvedValue(domain());
    renderSection();

    await userEvent.type(await screen.findByLabelText('Domain'), 'Example.com');
    getSsoSettings.mockResolvedValue(settings({ domains: [domain()] }));
    await userEvent.click(screen.getByRole('button', { name: 'Add domain' }));

    expect(addSsoDomain).toHaveBeenCalledWith('example.com');
    expect(
      await screen.findByText('standupless-sso=abc123')
    ).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy Value' })
    ).toBeInTheDocument();
  });

  it('verifies a domain', async () => {
    getSsoSettings.mockResolvedValue(settings({ domains: [domain()] }));
    verifySsoDomain.mockResolvedValue(
      domain({ verified: true, verified_at: '2026-10-16T01:00:00Z' })
    );
    renderSection();

    const verify = await screen.findByRole('button', { name: 'Verify' });
    getSsoSettings.mockResolvedValue(
      settings({
        domains: [
          domain({ verified: true, verified_at: '2026-10-16T01:00:00Z' }),
        ],
      })
    );
    await userEvent.click(verify);

    expect(verifySsoDomain).toHaveBeenCalledWith('example.com');
    expect(
      (await screen.findAllByText('Verified', { selector: 'span' }))[0]
    ).toBeInTheDocument();
  });

  it('saves an OIDC connection and keeps a blank secret', async () => {
    getSsoSettings.mockResolvedValue(settings({ connection: connection() }));
    saveSsoConnection.mockResolvedValue(settings({ connection: connection() }));
    renderSection('owner');

    const secret = await screen.findByLabelText('Client secret');
    expect(secret).toHaveAttribute('placeholder', 'Stored');
    const issuer = screen.getByLabelText('Issuer URL');
    await userEvent.clear(issuer);
    await userEvent.type(issuer, 'https://sso.example.com');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save connection' })
    );

    await waitFor(() => {
      expect(saveSsoConnection).toHaveBeenCalledWith({
        protocol: 'oidc',
        display_name: 'Okta',
        oidc_issuer: 'https://sso.example.com',
        oidc_client_id: 'client-1',
        oidc_client_secret: '',
        oidc_scopes: ['openid', 'email', 'profile'],
      });
    });
  });

  it('shows a refused field beside that field', async () => {
    saveSsoConnection.mockRejectedValue(
      new ApiError({
        status: 422,
        statusText: 'Unprocessable Entity',
        body: {
          success: false,
          message: 'The issuer did not answer with a discovery document.',
          error_code: 'SSO_CONNECTION_INVALID',
          field: 'oidc_issuer',
        },
        url: '/api/workspaces/ws-1/sso/connection',
        method: 'PUT',
      })
    );
    renderSection('owner');

    await userEvent.type(
      await screen.findByLabelText('Issuer URL'),
      'https://bad.example.com'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Save connection' })
    );

    expect(
      await screen.findByText(
        'The issuer did not answer with a discovery document.'
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Issuer URL')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('leaves the connection read only for an admin', async () => {
    getSsoSettings.mockResolvedValue(settings({ connection: connection() }));
    renderSection('admin');

    expect(
      await screen.findByText(/Only an owner can change the identity provider/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save connection' })
    ).toBeDisabled();
    expect(screen.getByLabelText('Issuer URL')).toBeDisabled();
    expect(screen.getByTestId('sso-test')).toBeEnabled();
  });

  it('shows the SAML service provider values', async () => {
    renderSection();

    await userEvent.selectOptions(
      await screen.findByLabelText('Protocol'),
      'saml'
    );

    expect(
      screen.getByText('https://id.example.test/sso/saml/acs')
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://id.example.test/sso/saml/metadata')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Signing certificate')).toBeInTheDocument();
  });

  it('starts a test sign-in that returns to this page', async () => {
    getSsoSettings.mockResolvedValue(settings({ connection: connection() }));
    renderSection();

    await userEvent.click(await screen.findByTestId('sso-test'));

    expect(beginSso).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'ws-1',
        returnTo: '/w/engineering/settings/security?sso_test=1',
      })
    );
  });

  it('records the test sign-in once on its return', async () => {
    getSsoSettings.mockResolvedValue(settings({ connection: connection() }));
    recordSsoTestResult.mockResolvedValue(
      settings({
        connection: connection({
          tested: true,
          tested_at: '2026-10-16T02:00:00Z',
        }),
      })
    );
    renderSection('admin', '/w/engineering/settings/security?sso_test=1');

    expect(
      await screen.findByText(
        'Test sign-in worked. Single sign-on can now be required.'
      )
    ).toBeInTheDocument();
    expect(recordSsoTestResult).toHaveBeenCalledTimes(1);
  });

  it('says to run the test again when the session did not come through it', async () => {
    getSsoSettings.mockResolvedValue(settings({ connection: connection() }));
    recordSsoTestResult.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: {
          success: false,
          message:
            "Sign in through this workspace's connection first, then record the test.",
          error_code: 'SSO_TEST_REQUIRED',
        },
        url: '/api/workspaces/ws-1/sso/connection/test-result',
        method: 'POST',
      })
    );
    renderSection('admin', '/w/engineering/settings/security?sso_test=1');

    expect(
      await screen.findByText(
        'The test did not finish through single sign-on. Run it again.'
      )
    ).toBeInTheDocument();
  });

  it('holds the requirement off until the workspace is ready', async () => {
    renderSection();

    const toggle = await screen.findByRole('switch', {
      name: 'Require single sign-on',
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText('Verify a domain and finish a test sign-in first.')
    ).toBeInTheDocument();
  });

  it('holds the requirement off for an admin whose session came by password', async () => {
    getSsoSettings.mockResolvedValue(
      settings({ can_require: true, current_session_sso: false })
    );
    renderSection('admin');

    const toggle = await screen.findByRole('switch', {
      name: 'Require single sign-on',
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/Admins must be signed in through single sign-on/)
    ).toBeInTheDocument();
  });

  it('lets an owner require single sign-on once it is ready', async () => {
    getSsoSettings.mockResolvedValue(settings({ can_require: true }));
    updateSsoPolicy.mockResolvedValue(settings({ require_sso: true }));
    renderSection('owner');

    const toggle = await screen.findByRole('switch', {
      name: 'Require single sign-on',
    });
    expect(toggle).toBeEnabled();
    getSsoSettings.mockResolvedValue(
      settings({ can_require: true, require_sso: true })
    );
    await userEvent.click(toggle);

    expect(updateSsoPolicy).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });
});
