/**
 * The authenticator app section of the account page, built on the headless
 * `useTotpPanel` state machine. Turning the factor on or off refreshes the
 * session, so the `two_factor` claim a workspace's authentication policy checks
 * changes at once rather than at the next scheduled refresh.
 */

import React, { useCallback, useMemo } from 'react';
import { useTotpPanel, type TotpPanel } from '@webbpulse/auth/panels';
import { qrCodeSvgPath } from '@webbpulse/qrcode';
import { LuShieldCheck, LuSmartphone } from 'react-icons/lu';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Input from '../ui/input';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';

/** The QR code for a provisioning URI, drawn as one SVG path. */
const ProvisioningQr: React.FC<{ uri: string }> = ({ uri }) => {
  const qr = useMemo(() => qrCodeSvgPath(uri), [uri]);
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={qr.viewBox}
      className="h-40 w-40 shrink-0 rounded-md bg-white"
      shapeRendering="crispEdges"
    >
      <path d={qr.path} fill="#000" />
    </svg>
  );
};

/** Props for CodePrompt: the panel, the submit handler and its label. */
interface CodePromptProps {
  panel: TotpPanel;
  label: string;
  submitLabel: string;
  danger?: boolean;
  onSubmit: () => Promise<void>;
}

/** The six digit code field with its submit and cancel buttons, submitted on Enter. */
const CodePrompt: React.FC<CodePromptProps> = ({
  panel,
  label,
  submitLabel,
  danger = false,
  onSubmit,
}) => (
  <form
    className="flex items-center gap-2"
    onSubmit={(event) => {
      event.preventDefault();
      void onSubmit();
    }}
  >
    <Input
      aria-label={label}
      className="h-7 w-36 font-mono tracking-widest"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123456"
      autoFocus
      value={panel.code}
      onChange={(event) => panel.setCode(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') panel.reset();
      }}
      disabled={panel.busy}
    />
    <Button
      type="submit"
      variant={danger ? 'danger' : 'primary'}
      size="sm"
      disabled={panel.busy || panel.code.trim() === ''}
    >
      {submitLabel}
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={panel.reset}
      disabled={panel.busy}
    >
      Cancel
    </Button>
  </form>
);

/** The recovery codes, shown once after activation or regeneration. */
const RecoveryCodes: React.FC<{ codes: string[]; onDone: () => void }> = ({
  codes,
  onDone,
}) => (
  <div className="space-y-3 rounded-md border border-line p-3">
    <p className="text-sm text-text-muted">
      Save these recovery codes somewhere safe. Each one signs you in once if
      you lose your device, and they are not shown again.
    </p>
    <ul
      aria-label="Recovery codes"
      className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm text-text sm:grid-cols-4"
    >
      {codes.map((code) => (
        <li key={code}>{code}</li>
      ))}
    </ul>
    <div className="flex gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}
      >
        Copy
      </Button>
      <Button variant="primary" size="sm" onClick={onDone}>
        I saved them
      </Button>
    </div>
  </div>
);

/** The section itself, mounted only once a client exists. */
const TwoFactorSection: React.FC<{ client: IdentityClient }> = ({ client }) => {
  const { user } = useAuth();
  const onChanged = useCallback(() => {
    void client.refresh().then(() => client.reloadUser());
  }, [client]);
  const panel = useTotpPanel({
    client,
    factor:
      user === null ? 'unknown' : user.two_factor ? 'enabled' : 'disabled',
    onChanged,
    messages: {
      disabled: 'Authenticator app removed.',
      saved: 'Two-factor authentication is on.',
    },
  });

  if (panel.unavailable) return null;

  const enabled = panel.factor === 'enabled';
  const idle = panel.step.kind === 'idle' && panel.prompt === 'none';

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Two-factor authentication</h2>
        <p className="text-sm text-text-muted">
          Ask for a code from an authenticator app when you sign in with a
          password.
        </p>
      </div>

      <ConfirmationAlert message={panel.notice} />
      <ErrorAlert message={panel.error} />

      <div className="rounded-md border border-line">
        <div className="flex min-h-row items-center gap-3 px-3 py-1.5">
          {enabled ? (
            <LuShieldCheck
              className="h-4 w-4 shrink-0 text-accent"
              aria-hidden="true"
            />
          ) : (
            <LuSmartphone
              className="h-4 w-4 shrink-0 text-text-faint"
              aria-hidden="true"
            />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            Authenticator app
          </span>
          <span className="shrink-0 text-xs text-text-muted">
            {enabled ? 'On' : 'Off'}
          </span>
          {idle && !enabled && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void panel.enrol()}
              disabled={panel.busy}
            >
              Set up
            </Button>
          )}
          {idle && enabled && (
            <span className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => panel.ask('regenerate')}
              >
                New recovery codes
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => panel.ask('disable')}
              >
                Remove
              </Button>
            </span>
          )}
        </div>

        {panel.step.kind === 'scanning' && (
          <div className="flex flex-col gap-4 border-t border-line p-3 sm:flex-row">
            <ProvisioningQr uri={panel.step.provisioningUri} />
            <div className="min-w-0 space-y-3">
              <p className="text-sm text-text-muted">
                Scan the code with your authenticator app, or enter this key by
                hand, then type the six digit code it shows.
              </p>
              <code className="block break-all font-mono text-sm text-text">
                {panel.step.secret}
              </code>
              <CodePrompt
                panel={panel}
                label="Code from your authenticator app"
                submitLabel="Turn on"
                onSubmit={panel.activate}
              />
            </div>
          </div>
        )}

        {panel.step.kind === 'idle' && panel.prompt === 'disable' && (
          <div className="space-y-2 border-t border-line p-3">
            <p className="text-sm text-text-muted">
              Enter a code from your app or a recovery code to remove it.
            </p>
            <CodePrompt
              panel={panel}
              label="Code to remove the authenticator app"
              submitLabel="Remove"
              danger
              onSubmit={panel.disable}
            />
          </div>
        )}

        {panel.step.kind === 'idle' && panel.prompt === 'regenerate' && (
          <div className="space-y-2 border-t border-line p-3">
            <p className="text-sm text-text-muted">
              Enter a code to replace your recovery codes. The old ones stop
              working.
            </p>
            <CodePrompt
              panel={panel}
              label="Code to replace your recovery codes"
              submitLabel="Replace"
              onSubmit={panel.regenerate}
            />
          </div>
        )}

        {panel.step.kind === 'codes' && (
          <div className="border-t border-line p-3">
            <RecoveryCodes
              codes={panel.step.codes}
              onDone={panel.acknowledgeCodes}
            />
          </div>
        )}
      </div>
    </section>
  );
};

/** Renders the two-factor section, or nothing when no identity client could be built. */
const TwoFactorPanel: React.FC = () => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <TwoFactorSection client={client} />;
};

export default TwoFactorPanel;
