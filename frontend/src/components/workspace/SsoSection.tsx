/**
 * Single sign-on for a workspace: the email domains it proves with a DNS TXT
 * record, the OIDC or SAML connection to its identity provider, a test
 * sign-in that proves the connection, and the switch that requires it.
 *
 * The switch stays off until the server says the workspace is ready, and for
 * an admin until their own session came through the connection, so nobody
 * turns it on and locks themselves out. Owners keep password sign-in either
 * way. A test sign-in returns here with `sso_test=1`, and the section records
 * it once.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { LuCheck, LuCopy, LuX } from 'react-icons/lu';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  addSsoDomain,
  getSsoSettings,
  recordSsoTestResult,
  removeSsoConnection,
  removeSsoDomain,
  saveSsoConnection,
  updateSsoPolicy,
  verifySsoDomain,
} from '../../api/workspaces';
import { useAuth } from '../../hooks/useAuth';
import { useCopy } from '../../hooks/useCopy';
import { cn } from '../../lib/cn';
import { errorCode, errorMessage } from '../../lib/errors';
import { workspaceSsoKey } from '../../lib/queryKeys';
import {
  beginSso,
  SSO_ERROR_PARAM,
  SSO_PARAM,
  SSO_TEST_PARAM,
  SSO_TEST_REQUIRED,
  ssoInvalidField,
} from '../../lib/sso';
import { showToast } from '../../lib/toast';
import type {
  SsoConnectionField,
  SsoConnectionRead,
  SsoConnectionUpdate,
  SsoDomainRead,
  SsoProtocol,
  SsoSettingsRead,
  WorkspaceRead,
} from '../../types/Api';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Field from '../ui/field';
import Input, { Textarea } from '../ui/input';
import Label from '../ui/label';
import TextLink from '../ui/link';
import RelativeTime from '../ui/relative-time';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for SsoSection: the workspace whose single sign-on is shown. */
export interface SsoSectionProps {
  workspace: WorkspaceRead;
}

/** How often the settings are re-read while the tab is open. */
const POLL_MS = 60000;

/** The connection form as typed, before it becomes a request body. */
interface ConnectionDraft {
  protocol: SsoProtocol;
  displayName: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcScopes: string;
  samlMetadataXml: string;
  samlEntityId: string;
  samlSsoUrl: string;
  samlCertificate: string;
}

/** The form a stored connection, or none, starts from. */
const draftFrom = (connection: SsoConnectionRead | null): ConnectionDraft => ({
  protocol: connection?.protocol ?? 'oidc',
  displayName: connection?.display_name ?? '',
  oidcIssuer: connection?.oidc_issuer ?? '',
  oidcClientId: connection?.oidc_client_id ?? '',
  oidcClientSecret: '',
  oidcScopes: (connection?.oidc_scopes ?? []).join(' '),
  samlMetadataXml: '',
  samlEntityId: connection?.saml_idp_entity_id ?? '',
  samlSsoUrl: connection?.saml_idp_sso_url ?? '',
  samlCertificate: '',
});

/** The scopes typed, split on spaces and commas, or null for the default. */
const scopesOf = (typed: string): string[] | null => {
  const scopes = typed
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  return scopes.length === 0 ? null : scopes;
};

/** The request body a draft saves as, for its protocol only. */
const bodyOf = (draft: ConnectionDraft): SsoConnectionUpdate => {
  const shared = { display_name: draft.displayName.trim() };
  if (draft.protocol === 'oidc') {
    return {
      protocol: 'oidc',
      ...shared,
      oidc_issuer: draft.oidcIssuer.trim(),
      oidc_client_id: draft.oidcClientId.trim(),
      oidc_client_secret: draft.oidcClientSecret.trim(),
      oidc_scopes: scopesOf(draft.oidcScopes),
    };
  }
  if (draft.samlMetadataXml.trim() !== '') {
    return {
      protocol: 'saml',
      ...shared,
      saml_metadata_xml: draft.samlMetadataXml,
    };
  }
  return {
    protocol: 'saml',
    ...shared,
    saml_idp_entity_id: draft.samlEntityId.trim(),
    saml_idp_sso_url: draft.samlSsoUrl.trim(),
    saml_idp_certificate: draft.samlCertificate,
  };
};

/** A value to paste somewhere else, with a button that copies it. */
const CopyRow: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => {
  const { copied, copy } = useCopy();
  return (
    <div className="flex min-h-row items-center justify-between gap-3 px-3 py-1.5">
      <div className="min-w-0 space-y-0.5">
        <span className="block text-xs text-text-faint">{label}</span>
        <code className="block font-mono text-xs break-all text-text">
          {value}
        </code>
      </div>
      <IconButton
        label={copied ? `Copied ${label}` : `Copy ${label}`}
        size="sm"
        onClick={() => {
          copy(value);
        }}
      >
        {copied ? (
          <LuCheck className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <LuCopy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </IconButton>
    </div>
  );
};

/** The refusal under one connection field, when the server named it. */
const FieldError: React.FC<{ id: string; message: string | null }> = ({
  id,
  message,
}) =>
  message === null ? null : (
    <p id={id} role="alert" className="text-xs text-danger">
      {message}
    </p>
  );

/** Props for DomainRow: one domain and what its buttons do. */
interface DomainRowProps {
  row: SsoDomainRead;
  busy: boolean;
  onVerify: (domain: string) => void;
  onRemove: (domain: string) => void;
}

/** One domain, with its TXT record until it is verified. */
const DomainRow: React.FC<DomainRowProps> = ({
  row,
  busy,
  onVerify,
  onRemove,
}) => (
  <li className="space-y-2 px-3 py-2">
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-text">
          {row.domain}
        </span>
        {row.verified ? (
          <Badge tone="success">Verified</Badge>
        ) : (
          <Badge tone="warning">Not verified</Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!row.verified && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onVerify(row.domain);
            }}
          >
            Verify
          </Button>
        )}
        <IconButton
          label={`Remove ${row.domain}`}
          size="sm"
          disabled={busy}
          onClick={() => {
            onRemove(row.domain);
          }}
        >
          <LuX className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>
    </div>
    {row.verified ? (
      row.verified_at !== null &&
      row.verified_at !== undefined && (
        <p className="text-xs text-text-faint">
          Verified <RelativeTime value={row.verified_at} />
        </p>
      )
    ) : (
      <div className="space-y-1">
        <p className="text-xs text-text-muted">
          Add this TXT record at your DNS provider, then verify. Records can
          take a few minutes to appear.
        </p>
        <div className="divide-y divide-line rounded-md border border-line">
          <CopyRow label="Name" value={row.record_name} />
          <CopyRow label="Type" value={row.record_type} />
          <CopyRow label="Value" value={row.record_value} />
        </div>
      </div>
    )}
  </li>
);

/** Lists the domains, proves and removes them, and adds new ones. */
const DomainsBlock: React.FC<{
  workspaceId: string;
  domains: SsoDomainRead[];
  refetch: () => Promise<unknown>;
}> = ({ workspaceId, domains, refetch }) => {
  const queryKey = workspaceSsoKey(workspaceId);
  const inputId = useId();
  const [domain, setDomain] = useState('');

  const add = useMutationWithRefetch(
    (value: string) => addSsoDomain(workspaceId, value),
    [queryKey]
  );
  const verify = useMutationWithRefetch(
    (value: string) => verifySsoDomain(workspaceId, value),
    [queryKey]
  );
  const remove = useMutationWithRefetch(
    (value: string) => removeSsoDomain(workspaceId, value),
    [queryKey]
  );
  const busy = add.isMutating || verify.isMutating || remove.isMutating;

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = domain.trim().toLowerCase();
    if (value === '' || busy) return;
    try {
      await add.mutate(value);
      setDomain('');
      await refetch();
    } catch {
      return;
    }
  };

  const check = async (value: string) => {
    try {
      const row = await verify.mutate(value);
      await refetch();
      if (row.verified) showToast(`${value} is verified.`);
    } catch {
      return;
    }
  };

  const drop = async (value: string) => {
    try {
      await remove.mutate(value);
      await refetch();
      showToast(`${value} was removed.`);
    } catch {
      return;
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">Domains</h3>
        <p className="text-xs text-text-muted">
          Only addresses on a verified domain can sign in through your identity
          provider.
        </p>
      </div>
      {add.error !== null && (
        <ErrorAlert
          message={errorMessage(add.error, 'Could not add the domain.')}
        />
      )}
      {verify.error !== null && (
        <ErrorAlert
          message={errorMessage(verify.error, 'Could not verify the domain.')}
        />
      )}
      {remove.error !== null && (
        <ErrorAlert
          message={errorMessage(remove.error, 'Could not remove the domain.')}
        />
      )}
      <ul
        aria-label="Single sign-on domains"
        className="divide-y divide-line rounded-md border border-line"
      >
        {domains.length === 0 && (
          <li className="flex min-h-row items-center px-3 py-2 text-sm text-text-muted">
            No domains yet.
          </li>
        )}
        {domains.map((row) => (
          <DomainRow
            key={row.domain}
            row={row}
            busy={busy}
            onVerify={(value) => {
              void check(value);
            }}
            onRemove={(value) => {
              void drop(value);
            }}
          />
        ))}
        <li className="px-3 py-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <Label htmlFor={inputId} hidden>
              Domain
            </Label>
            <Input
              id={inputId}
              placeholder="example.com"
              value={domain}
              disabled={busy}
              onChange={(event) => setDomain(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={busy || domain.trim() === ''}
            >
              Add domain
            </Button>
          </form>
        </li>
      </ul>
    </div>
  );
};

/** Props for ConnectionBlock: the settings and how to re-read them. */
interface ConnectionBlockProps {
  workspace: WorkspaceRead;
  settings: SsoSettingsRead;
  refetch: () => Promise<unknown>;
}

/** The identity provider form, the values to give it, and the test sign-in. */
const ConnectionBlock: React.FC<ConnectionBlockProps> = ({
  workspace,
  settings,
  refetch,
}) => {
  const queryKey = workspaceSsoKey(workspace.id);
  const { logout } = useAuth();
  const location = useLocation();
  const connection = settings.connection;
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const form = draft ?? draftFrom(connection);

  const save = useMutationWithRefetch(
    (body: SsoConnectionUpdate) => saveSsoConnection(workspace.id, body),
    [queryKey]
  );
  const remove = useMutationWithRefetch(
    () => removeSsoConnection(workspace.id),
    [queryKey]
  );
  const busy = save.isMutating || remove.isMutating || testing;
  const badField = ssoInvalidField(save.error);
  const fieldError = (field: SsoConnectionField): string | null =>
    badField === field ? errorMessage(save.error, 'Check this value.') : null;
  const fieldProps = (field: SsoConnectionField) =>
    badField === field
      ? { 'aria-invalid': true, 'aria-errormessage': `sso-${field}-error` }
      : {};

  const change = (patch: Partial<ConnectionDraft>) => {
    setDraft({ ...form, ...patch });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    try {
      await save.mutate(bodyOf(form));
      setDraft(null);
      await refetch();
      showToast('Connection saved. Run a test sign-in to prove it.');
    } catch {
      return;
    }
  };

  const drop = async () => {
    if (busy) return;
    try {
      await remove.mutate();
      setDraft(null);
      await refetch();
      showToast('Connection removed.');
    } catch {
      return;
    }
  };

  const test = async () => {
    setTesting(true);
    setTestError(null);
    try {
      await beginSso({
        connectionId: workspace.id,
        returnTo: `${location.pathname}?${SSO_TEST_PARAM}=1`,
        signOut: () => logout(),
      });
    } catch (error) {
      setTesting(false);
      setTestError(
        errorMessage(error, 'Could not start the test sign-in. Try again.')
      );
    }
  };

  const provider = settings.service_provider;
  const generalError =
    save.error !== null && badField === null
      ? errorMessage(save.error, 'Could not save the connection.')
      : null;

  return (
    <div className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">Identity provider</h3>
        <p className="text-xs text-text-muted">
          Connect the provider your company signs in with, such as Okta, Google
          Workspace or Microsoft Entra ID.
        </p>
      </div>

      <div className="space-y-1">
        <p className="text-xs font-medium text-text-muted">
          Give your provider these values
        </p>
        <div className="divide-y divide-line rounded-md border border-line">
          {form.protocol === 'oidc' ? (
            <CopyRow label="Redirect URI" value={provider.oidc_redirect_uri} />
          ) : (
            <>
              <CopyRow label="ACS URL" value={provider.saml_acs_url} />
              <CopyRow label="Entity ID" value={provider.saml_entity_id} />
              <CopyRow label="Metadata URL" value={provider.saml_metadata_url} />
            </>
          )}
        </div>
      </div>

      <form
        className="space-y-3"
        aria-label="Single sign-on connection"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <SelectField
          id="sso-protocol"
          label="Protocol"
          value={form.protocol}
          disabled={busy}
          onChange={(event) =>
            change({ protocol: event.target.value as SsoProtocol })
          }
        >
          <option value="oidc">OpenID Connect (OIDC)</option>
          <option value="saml">SAML 2.0</option>
        </SelectField>
        <Field
          id="sso-display-name"
          label="Name"
          hint="Optional. Shown to people when they sign in."
          value={form.displayName}
          disabled={busy}
          onChange={(event) => change({ displayName: event.target.value })}
        />

        {form.protocol === 'oidc' ? (
          <>
            <div className="space-y-1">
              <Field
                id="sso-oidc_issuer"
                label="Issuer URL"
                placeholder="https://login.example.com"
                value={form.oidcIssuer}
                disabled={busy}
                onChange={(event) => change({ oidcIssuer: event.target.value })}
                {...fieldProps('oidc_issuer')}
              />
              <FieldError
                id="sso-oidc_issuer-error"
                message={fieldError('oidc_issuer')}
              />
            </div>
            <div className="space-y-1">
              <Field
                id="sso-oidc_client_id"
                label="Client ID"
                value={form.oidcClientId}
                disabled={busy}
                onChange={(event) =>
                  change({ oidcClientId: event.target.value })
                }
                {...fieldProps('oidc_client_id')}
              />
              <FieldError
                id="sso-oidc_client_id-error"
                message={fieldError('oidc_client_id')}
              />
            </div>
            <div className="space-y-1">
              <Field
                id="sso-oidc_client_secret"
                label="Client secret"
                type="password"
                autoComplete="off"
                placeholder={connection?.has_client_secret ? 'Stored' : ''}
                {...(connection?.has_client_secret
                  ? { hint: 'Leave blank to keep the stored secret.' }
                  : {})}
                value={form.oidcClientSecret}
                disabled={busy}
                onChange={(event) =>
                  change({ oidcClientSecret: event.target.value })
                }
                {...fieldProps('oidc_client_secret')}
              />
              <FieldError
                id="sso-oidc_client_secret-error"
                message={fieldError('oidc_client_secret')}
              />
            </div>
            <Field
              id="sso-oidc-scopes"
              label="Scopes"
              placeholder="openid email profile"
              hint="Optional. Separate with spaces. openid is always included."
              value={form.oidcScopes}
              disabled={busy}
              onChange={(event) => change({ oidcScopes: event.target.value })}
            />
          </>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="sso-saml_metadata_xml">Metadata XML</Label>
              <Textarea
                id="sso-saml_metadata_xml"
                className="font-mono text-xs"
                value={form.samlMetadataXml}
                disabled={busy}
                onChange={(event) =>
                  change({ samlMetadataXml: event.target.value })
                }
                {...fieldProps('saml_metadata_xml')}
              />
              <p className="text-xs text-text-faint">
                Paste your provider's metadata, or leave it blank and enter the
                three values below.
              </p>
              <FieldError
                id="sso-saml_metadata_xml-error"
                message={fieldError('saml_metadata_xml')}
              />
            </div>
            <div className="space-y-1">
              <Field
                id="sso-saml_idp_entity_id"
                label="Provider entity ID"
                value={form.samlEntityId}
                disabled={busy}
                onChange={(event) =>
                  change({ samlEntityId: event.target.value })
                }
                {...fieldProps('saml_idp_entity_id')}
              />
              <FieldError
                id="sso-saml_idp_entity_id-error"
                message={fieldError('saml_idp_entity_id')}
              />
            </div>
            <div className="space-y-1">
              <Field
                id="sso-saml_idp_sso_url"
                label="Provider sign-in URL"
                placeholder="https://login.example.com/saml"
                value={form.samlSsoUrl}
                disabled={busy}
                onChange={(event) => change({ samlSsoUrl: event.target.value })}
                {...fieldProps('saml_idp_sso_url')}
              />
              <FieldError
                id="sso-saml_idp_sso_url-error"
                message={fieldError('saml_idp_sso_url')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sso-saml_idp_certificate">
                Signing certificate
              </Label>
              <Textarea
                id="sso-saml_idp_certificate"
                className="font-mono text-xs"
                placeholder="-----BEGIN CERTIFICATE-----"
                value={form.samlCertificate}
                disabled={busy}
                onChange={(event) =>
                  change({ samlCertificate: event.target.value })
                }
                {...fieldProps('saml_idp_certificate')}
              />
              {connection?.protocol === 'saml' &&
                connection.saml_certificate_count > 0 && (
                  <p className="text-xs text-text-faint">
                    A certificate is stored. Paste the metadata or the
                    certificate again to save a change.
                  </p>
                )}
              <FieldError
                id="sso-saml_idp_certificate-error"
                message={fieldError('saml_idp_certificate')}
              />
            </div>
          </>
        )}

        <ErrorAlert message={generalError} />
        {remove.error !== null && (
          <ErrorAlert
            message={errorMessage(
              remove.error,
              'Could not remove the connection.'
            )}
          />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {save.isMutating ? 'Saving' : 'Save connection'}
          </Button>
          {connection !== null && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void drop();
              }}
            >
              Remove connection
            </Button>
          )}
        </div>
      </form>

      {connection !== null && (
        <div className="space-y-2 rounded-md border border-line px-3 py-2">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text">
                  Test sign-in
                </span>
                {connection.tested ? (
                  <Badge tone="success">Tested</Badge>
                ) : (
                  <Badge tone="warning">Not tested</Badge>
                )}
              </div>
              <p className="text-xs text-text-faint">
                {connection.tested &&
                connection.tested_at !== null &&
                connection.tested_at !== undefined ? (
                  <>
                    Last tested <RelativeTime value={connection.tested_at} />.
                  </>
                ) : (
                  'You will be signed out and sign in again through your provider.'
                )}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || draft !== null}
              onClick={() => {
                void test();
              }}
              data-testid="sso-test"
            >
              {testing ? 'Opening' : 'Test sign-in'}
            </Button>
          </div>
          <ErrorAlert message={testError} />
        </div>
      )}
    </div>
  );
};

/** Props for RequireBlock: the settings and how to re-read them. */
interface RequireBlockProps {
  workspace: WorkspaceRead;
  settings: SsoSettingsRead;
  refetch: () => Promise<unknown>;
}

/** The switch that requires single sign-on, and why it is held off. */
const RequireBlock: React.FC<RequireBlockProps> = ({
  workspace,
  settings,
  refetch,
}) => {
  const labelId = useId();
  const queryKey = workspaceSsoKey(workspace.id);
  const policy = useMutationWithRefetch(
    (next: boolean) => updateSsoPolicy(workspace.id, next),
    [queryKey]
  );
  const required = settings.require_sso;
  const owner = workspace.role === 'owner';
  const needsSession = !owner && !settings.current_session_sso;
  const locked = !required && (!settings.can_require || needsSession);

  const toggle = async () => {
    if (policy.isMutating || locked) return;
    try {
      await policy.mutate(!required);
      await refetch();
      showToast(
        required
          ? 'Single sign-on is no longer required.'
          : 'Single sign-on is now required.'
      );
    } catch {
      return;
    }
  };

  const verified = settings.domains.some((row) => row.verified);
  const tested = settings.connection?.tested === true;

  return (
    <div className="space-y-2">
      {policy.error !== null && (
        <ErrorAlert
          message={errorMessage(policy.error, 'Could not change the policy.')}
        />
      )}
      <div className="flex min-h-row items-center justify-between gap-4 rounded-md border border-line px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <span id={labelId} className="block text-sm font-medium text-text">
            Require single sign-on
          </span>
          <p className="text-xs text-text-muted">
            Members and admins must sign in through your identity provider.
            Owners can still sign in with a password, so the workspace is never
            locked out.
          </p>
          {locked && !settings.can_require && (
            <p className="text-xs text-text-faint">
              {!verified && !tested
                ? 'Verify a domain and finish a test sign-in first.'
                : !verified
                  ? 'Verify a domain first.'
                  : 'Finish a test sign-in first.'}
            </p>
          )}
          {locked && settings.can_require && needsSession && (
            <p className="text-xs text-text-faint">
              Admins must be signed in through single sign-on to turn this on.
              Run a test sign-in first.
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={required}
          aria-labelledby={labelId}
          disabled={policy.isMutating || locked}
          onClick={() => {
            void toggle();
          }}
          className={cn(
            'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
            required
              ? 'bg-accent enabled:hover:bg-accent-strong'
              : 'bg-line-strong enabled:hover:bg-text-faint'
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'inline-block h-3 w-3 rounded-full bg-bg shadow-sm transition-transform duration-100',
              required ? 'translate-x-3' : 'translate-x-0'
            )}
          />
        </button>
      </div>
    </div>
  );
};

/** Records a test sign-in once, when the page opened on its return. */
const useTestReturn = (
  workspaceId: string,
  refetch: () => Promise<unknown>
): { note: string | null; error: string | null } => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [pending] = useState(
    () =>
      searchParams.get(SSO_TEST_PARAM) === '1' &&
      searchParams.get(SSO_ERROR_PARAM) === null
  );
  const started = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryKey = workspaceSsoKey(workspaceId);
  const record = useMutationWithRefetch(
    () => recordSsoTestResult(workspaceId),
    [queryKey]
  );
  const { mutate } = record;

  useEffect(() => {
    if (!pending || started.current) return;
    started.current = true;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(SSO_TEST_PARAM);
        next.delete(SSO_PARAM);
        return next;
      },
      { replace: true }
    );
    void mutate()
      .then(async () => {
        setNote('Test sign-in worked. Single sign-on can now be required.');
        await refetch();
      })
      .catch((failure: unknown) => {
        setError(
          errorCode(failure) === SSO_TEST_REQUIRED
            ? 'The test did not finish through single sign-on. Run it again.'
            : errorMessage(failure, 'Could not record the test sign-in.')
        );
      });
  }, [pending, mutate, refetch, setSearchParams]);

  return { note, error };
};

/** Shows and changes a workspace's single sign-on for an owner or admin. */
export const SsoSection: React.FC<SsoSectionProps> = ({ workspace }) => {
  const auth = useQueryAuth();
  const queryKey = workspaceSsoKey(workspace.id);
  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getSsoSettings(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );
  const testReturn = useTestReturn(workspace.id, refetch);

  return (
    <section className="space-y-4" aria-labelledby="sso-heading">
      <div className="space-y-1">
        <h2 id="sso-heading" className="text-base font-semibold">
          Single sign-on
        </h2>
        <p className="text-sm text-text-muted">
          Let people sign in to {workspace.name} through your identity provider
          with OIDC or SAML. New people on a verified domain join as members
          the first time they sign in.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load single sign-on.')}
        />
      )}
      <ConfirmationAlert message={testReturn.note} />
      <ErrorAlert message={testReturn.error} />

      {isLoading && data === null ? (
        <Spinner label="Loading single sign-on" />
      ) : data === null ? null : !data.available ? (
        <p className="text-sm text-text-muted">
          Available on the Business plan.{' '}
          <TextLink to={`/w/${workspace.slug}/settings/billing`}>
            View plans
          </TextLink>
        </p>
      ) : (
        <div className="space-y-6">
          <DomainsBlock
            workspaceId={workspace.id}
            domains={data.domains}
            refetch={refetch}
          />
          <ConnectionBlock
            key={data.connection?.updated_at ?? 'none'}
            workspace={workspace}
            settings={data}
            refetch={refetch}
          />
          <RequireBlock workspace={workspace} settings={data} refetch={refetch} />
        </div>
      )}
    </section>
  );
};

export default SsoSection;
