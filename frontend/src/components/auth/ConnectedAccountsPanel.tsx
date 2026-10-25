/**
 * The connected accounts section: one row per sign-in provider this
 * deployment offers, showing the linked account or "Not connected", with
 * Connect and Disconnect. The state machine is `useConnectedAccountsPanel`
 * from `@webbpulse/auth`, wired to the step-up gate so a `STEP_UP_REQUIRED`
 * refusal waits behind the verify prompt and replays once the person has
 * proven it is them. The provider callback lands back here, where its flag
 * becomes a toast.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GITHUB_PROVIDER,
  GOOGLE_PROVIDER,
  StepUpCancelledError,
  describeOAuthCallbackError,
  readOAuthCallback,
  stripOAuthParams,
  type OAuthLink,
} from '@webbpulse/auth';
import { useConnectedAccountsPanel } from '@webbpulse/auth/panels';
import { useStepUp, type StepUpGate } from '@webbpulse/auth/react';
import { useOAuthProviders } from '@webbpulse/discovery/react';
import { FaGithub, FaGoogle } from 'react-icons/fa';
import { LuLink } from 'react-icons/lu';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  getIdentityClient,
  identityOrigin,
  type IdentityClient,
  type OAuthProviderInfo,
} from '../../api/identityClient';
import { dateLabel } from '../../lib/accessDisplay';
import { SECURITY_PATH, accountLabel } from '../../lib/connectedAccounts';
import { errorMessage } from '../../lib/errors';
import { showErrorToast, showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import Spinner from '../ui/spinner';
import StepUpDialog from './StepUpDialog';

/** The provider's mark. */
const ProviderMark: React.FC<{ provider: string }> = ({ provider }) => {
  const className = 'h-4 w-4 shrink-0 text-text';
  if (provider === GITHUB_PROVIDER)
    return <FaGithub className={className} aria-hidden="true" />;
  if (provider === GOOGLE_PROVIDER)
    return <FaGoogle className={className} aria-hidden="true" />;
  return <LuLink className={className} aria-hidden="true" />;
};

/** Props for ProviderRow. */
interface ProviderRowProps {
  provider: OAuthProviderInfo;
  link: OAuthLink | undefined;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

/** One row: the mark, the provider and its account, and the one action. */
const ProviderRow: React.FC<ProviderRowProps> = ({
  provider,
  link,
  busy,
  onConnect,
  onDisconnect,
}) => (
  <li
    className="flex min-h-row items-center gap-3 px-3 py-2"
    data-testid={`connected-account-${provider.id}`}
  >
    <ProviderMark provider={provider.id} />
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-medium text-text">
        {provider.displayName}
      </p>
      <p className="truncate text-xs text-text-muted">
        {link === undefined ? (
          'Not connected'
        ) : (
          <>
            {accountLabel(link) || 'Connected'}
            <span className="hidden sm:inline">
              {' '}
              · Connected {dateLabel(link.linkedAt)}
            </span>
          </>
        )}
      </p>
    </div>
    {link === undefined ? (
      <Button
        variant="secondary"
        size="sm"
        onClick={onConnect}
        disabled={busy}
        aria-label={`Connect ${provider.displayName}`}
      >
        Connect
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        onClick={onDisconnect}
        disabled={busy}
        aria-label={`Disconnect ${provider.displayName}`}
      >
        Disconnect
      </Button>
    )}
  </li>
);

/** Props for DisconnectDialog. */
interface DisconnectDialogProps {
  open: boolean;
  providerName: string;
  account: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** The confirm in front of a disconnect, holding any refusal it came back with. */
const DisconnectDialog: React.FC<DisconnectDialogProps> = ({
  open,
  providerName,
  account,
  busy,
  error,
  onCancel,
  onConfirm,
}) => (
  <Dialog
    open={open}
    onClose={() => {
      if (!busy) onCancel();
    }}
    title={`Disconnect ${providerName}`}
    size="sm"
  >
    <div className="space-y-4">
      <p className="text-sm text-text-muted">
        {account === ''
          ? `You will no longer be able to sign in with ${providerName}.`
          : `You will no longer be able to sign in with ${providerName} as ${account}.`}{' '}
        You can connect it again later.
      </p>
      <ErrorAlert message={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={busy}>
          Disconnect
        </Button>
      </div>
    </div>
  </Dialog>
);

/** Turns the callback flags on this page's URL into a toast, once. */
const useCallbackToast = (): void => {
  const location = useLocation();
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const result = readOAuthCallback(location.search + location.hash);
    if (result === null) return;
    handled.current = true;
    if (result.kind === 'linked') {
      showToast('Account connected.');
    } else if (result.kind === 'signed-in') {
      showToast('Signed in again. You can now change your connected accounts.');
    } else if (result.kind === 'mfa-required') {
      showErrorToast(
        'That sign in needs your authenticator code. Confirm with the code instead.'
      );
    } else {
      showErrorToast(
        describeOAuthCallbackError(result, 'Could not connect that account.')
      );
    }
    const here = `${location.pathname}${location.search}${location.hash}`;
    void navigate(stripOAuthParams(here), { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);
};

/** The section, mounted only once a client exists. */
const ConnectedAccountsList: React.FC<{ client: IdentityClient }> = ({
  client,
}) => {
  const providers = useOAuthProviders({ identityOrigin: identityOrigin() });
  const gate = useStepUp();
  const [action, setAction] = useState('');
  const [confirming, setConfirming] = useState<OAuthProviderInfo | null>(null);
  useCallbackToast();

  const { withStepUp: gateStepUp } = gate;
  const withStepUp = useCallback<StepUpGate['withStepUp']>(
    (fn) => {
      const gated = gateStepUp(fn);
      return async (...args) => {
        try {
          return await gated(...args);
        } catch (thrown) {
          if (thrown instanceof StepUpCancelledError) setConfirming(null);
          throw thrown;
        }
      };
    },
    [gateStepUp]
  );

  const panel = useConnectedAccountsPanel({
    client,
    providers,
    returnTo: SECURITY_PATH,
    withStepUp,
  });
  const links = panel.items;

  const linkFor = useCallback(
    (provider: string): OAuthLink | undefined =>
      links?.find((row) => row.provider === provider),
    [links]
  );

  useEffect(() => {
    if (confirming === null || links === null) return;
    if (linkFor(confirming.id) !== undefined) return;
    setConfirming(null);
    if (panel.error === null)
      showToast(`${confirming.displayName} disconnected.`);
  }, [confirming, links, linkFor, panel.error]);

  if (providers.length === 0) return null;

  const confirmingLink =
    confirming === null ? undefined : linkFor(confirming.id);
  const reauth = (links ?? [])
    .map((row) => providers.find((p) => p.id === row.provider))
    .filter((p): p is OAuthProviderInfo => p !== undefined)
    .map((p) => ({
      label: `Sign in again with ${p.displayName}`,
      href: client.oauthStartUrl(p.id, { returnTo: SECURITY_PATH }),
    }));

  return (
    <section className="space-y-4" aria-labelledby="connected-accounts-title">
      <div className="space-y-1">
        <h2 id="connected-accounts-title" className="text-base font-semibold">
          Connected accounts
        </h2>
        <p className="text-sm text-text-muted">
          Accounts you can use to sign in to Standupless.
        </p>
      </div>

      <ErrorAlert message={confirming === null ? panel.error : null} />

      {panel.loading && <Spinner label="Loading connected accounts" />}

      {!panel.loading && !panel.unavailable && links !== null && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              link={linkFor(provider.id)}
              busy={panel.busy}
              onConnect={() => {
                setAction(`connect ${provider.displayName}`);
                panel
                  .link(provider.id)
                  .catch((error: unknown) =>
                    showErrorToast(
                      errorMessage(
                        error,
                        `Could not connect ${provider.displayName}.`
                      )
                    )
                  );
              }}
              onDisconnect={() => {
                panel.dismiss();
                setConfirming(provider);
              }}
            />
          ))}
        </ul>
      )}

      <DisconnectDialog
        open={confirming !== null && !gate.open}
        providerName={confirming?.displayName ?? ''}
        account={
          confirmingLink === undefined ? '' : accountLabel(confirmingLink)
        }
        busy={panel.busy}
        error={confirming === null ? null : panel.error}
        onCancel={() => {
          panel.dismiss();
          setConfirming(null);
        }}
        onConfirm={() => {
          if (confirming === null) return;
          setAction(`disconnect ${confirming.displayName}`);
          const provider = confirming;
          panel
            .unlink(provider.id)
            .catch((error: unknown) =>
              showErrorToast(
                errorMessage(
                  error,
                  `Could not disconnect ${provider.displayName}.`
                )
              )
            );
        }}
      />
      <StepUpDialog gate={gate} action={action} reauth={reauth} />
    </section>
  );
};

/** Renders the section, or nothing when no identity client could be built. */
const ConnectedAccountsPanel: React.FC = () => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <ConnectedAccountsList client={client} />;
};

export default ConnectedAccountsPanel;
