/**
 * The signed in person's live sessions, this one first and the rest most
 * recently active first, each other one revocable alone or all at once behind
 * a confirm step. Revoking ends that sign-in at its next refresh. The current
 * session is ended by signing out, so it has no revoke button. Each row names
 * the app, or the browser and operating system, the session runs in, the
 * address it was last seen from and, when that moved, where it signed in. An
 * MCP session links to Connected apps, where its grant is ended.
 */

import React, { useEffect, useState } from 'react';
import type { AccountSession } from '@webbpulse/auth';
import { useSessionsPanel } from '@webbpulse/auth/panels';
import { Link } from 'react-router-dom';
import {
  LuMonitor,
  LuSmartphone,
  LuBot,
  LuGlobe,
  LuLogOut,
  LuPlug,
} from 'react-icons/lu';
import { listMyConnectedApps } from '../../api/connectedApps';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';
import { sessionLabel } from '../../lib/account';
import { signInMethodLabel } from '../../lib/amr';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Dialog from '../ui/dialog';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** The icon for a session: a plug for a connected app, else its device class. */
const DeviceIcon: React.FC<{ session: AccountSession }> = ({ session }) => {
  const className = 'h-4 w-4 shrink-0 text-text-muted';
  const { device } = session;
  if (session.clientId !== '') {
    return <LuPlug className={className} aria-hidden="true" />;
  }
  if (device === 'mobile') {
    return <LuSmartphone className={className} aria-hidden="true" />;
  }
  if (device === 'desktop') {
    return <LuMonitor className={className} aria-hidden="true" />;
  }
  if (device === 'bot') {
    return <LuBot className={className} aria-hidden="true" />;
  }
  return <LuGlobe className={className} aria-hidden="true" />;
};

/** One session row. */
const SessionRow: React.FC<{
  session: AccountSession;
  appName: string;
  connectedAppsHref: string | undefined;
  busy: boolean;
  onRevoke: () => void;
}> = ({ session, appName, connectedAppsHref, busy, onRevoke }) => {
  const method = signInMethodLabel(session.amr);
  const lastIp = session.lastIp || session.ip;
  const movedFrom =
    session.ip !== '' && session.ip !== lastIp ? session.ip : '';
  return (
    <li
      className="flex min-h-row items-center gap-3 px-3 py-2"
      data-testid="session-row"
    >
      <DeviceIcon session={session} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">
            {sessionLabel(session, appName)}
          </span>
          {session.current && <Badge tone="accent">This session</Badge>}
        </div>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-faint">
          {method !== '' && <span>{method}</span>}
          {lastIp !== '' && <span>{lastIp}</span>}
          {session.lastActiveAt !== '' && (
            <span className="inline-flex items-center gap-1">
              Last active <RelativeTime value={session.lastActiveAt} />
            </span>
          )}
          {movedFrom !== '' && <span>Signed in from {movedFrom}</span>}
          {session.clientId !== '' && connectedAppsHref !== undefined && (
            <Link
              to={connectedAppsHref}
              className="text-text-muted underline-offset-2 hover:underline"
            >
              Manage in Connected apps
            </Link>
          )}
        </p>
      </div>
      {!session.current && (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRevoke}
          disabled={busy}
        >
          Revoke
        </Button>
      )}
    </li>
  );
};

/** The connected app names by client id, read once any session belongs to one. */
const useConnectedAppNames = (
  sessions: AccountSession[] | null
): Record<string, string> => {
  const [names, setNames] = useState<Record<string, string>>({});
  const wanted = sessions?.some((session) => session.clientId !== '') ?? false;

  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    listMyConnectedApps(controller.signal)
      .then((apps) => {
        setNames(
          Object.fromEntries(
            apps.map((app) => [app.client_id, app.client_name])
          )
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [wanted]);

  return names;
};

/** The confirm step before every other session is signed out. */
const SignOutOthersDialog: React.FC<{
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}> = ({ count, busy, onCancel, onConfirm }) => (
  <Dialog
    open
    size="sm"
    title="Sign out of all other sessions?"
    description={
      count === 1
        ? 'This signs out the other device signed in to your account. This session stays signed in.'
        : `This signs out the ${count} other devices signed in to your account. This session stays signed in.`
    }
    onClose={onCancel}
  >
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="danger" onClick={onConfirm} disabled={busy}>
        Sign out other sessions
      </Button>
    </div>
  </Dialog>
);

/** The list, mounted only once a client exists. */
const SessionList: React.FC<{
  client: IdentityClient;
  connectedAppsHref: string | undefined;
}> = ({ client, connectedAppsHref }) => {
  const panel = useSessionsPanel({
    client,
    messages: {
      removed: 'Session revoked.',
      revokedOthers: (count) =>
        count === 1
          ? 'Signed out of 1 other session.'
          : `Signed out of ${count} other sessions.`,
      failed: 'Could not reach the server. Try again.',
    },
  });
  const [confirming, setConfirming] = useState(false);
  const appNames = useConnectedAppNames(panel.items);
  const { notice, dismiss } = panel;

  useEffect(() => {
    if (notice === null) return;
    showToast(notice);
    dismiss();
  }, [notice, dismiss]);

  if (panel.unavailable) return null;

  const rows =
    panel.current !== null ? [panel.current, ...panel.others] : panel.others;

  const signOutOthers = async (): Promise<void> => {
    await panel.revokeOthers();
    setConfirming(false);
  };

  return (
    <section className="space-y-4" aria-labelledby="sessions-title">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 id="sessions-title" className="text-base font-semibold">
            Sessions
          </h2>
          <p className="text-sm text-text-muted">
            Devices signed in to your account. Revoke any you do not recognise.
          </p>
        </div>
        {panel.others.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={panel.busy}
          >
            <LuLogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out of all other sessions
          </Button>
        )}
      </div>
      <ErrorAlert message={panel.error} />
      {panel.loading && <Spinner label="Loading sessions" />}
      {rows.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              appName={appNames[session.clientId] ?? ''}
              connectedAppsHref={connectedAppsHref}
              busy={panel.busy}
              onRevoke={() => void panel.revoke(session.id)}
            />
          ))}
        </ul>
      )}
      {confirming && (
        <SignOutOthersDialog
          count={panel.others.length}
          busy={panel.busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void signOutOthers()}
        />
      )}
    </section>
  );
};

/**
 * Renders the sessions section, or nothing when no identity client could be
 * built. `connectedAppsHref` is where an MCP session's grant is managed, and
 * its link is left off where no workspace gives that page an address.
 */
const SessionsSection: React.FC<{ connectedAppsHref?: string }> = ({
  connectedAppsHref,
}) => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <SessionList client={client} connectedAppsHref={connectedAppsHref} />;
};

export default SessionsSection;
