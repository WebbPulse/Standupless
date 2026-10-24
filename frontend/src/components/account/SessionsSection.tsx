/**
 * The signed in person's live sessions, most recently active first, with the
 * one in this browser marked and every other one revocable. Revoking ends that
 * sign-in at its next refresh. The current session is ended by signing out,
 * so it has no revoke button. Each row names the app or browser the session
 * runs in, the address it was last seen from and, when that moved, where it
 * signed in. An MCP session links to Connected apps, where its grant is ended.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { AccountSession } from '@webbpulse/auth';
import { Link } from 'react-router-dom';
import {
  LuMonitor,
  LuSmartphone,
  LuBot,
  LuGlobe,
  LuPlug,
} from 'react-icons/lu';
import { listMyConnectedApps } from '../../api/connectedApps';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';
import { sessionLabel } from '../../lib/account';
import { signInMethodLabel } from '../../lib/amr';
import { errorMessage } from '../../lib/errors';
import { showErrorToast, showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
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

/** The list, mounted only once a client exists. */
const SessionList: React.FC<{
  client: IdentityClient;
  connectedAppsHref: string | undefined;
}> = ({ client, connectedAppsHref }) => {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const appNames = useConnectedAppNames(sessions);

  const load = useCallback(async (): Promise<void> => {
    try {
      const outcome = await client.listSessions();
      setSessions(outcome.sessions);
      setError(null);
    } catch (failure) {
      setError(errorMessage(failure, 'Could not load your sessions.'));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: AccountSession): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await client.revokeSession(session.id);
      if (outcome.ok || outcome.reason === 'not-found') {
        showToast('Session revoked.');
      } else {
        showErrorToast(outcome.message);
      }
      await load();
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not revoke that session.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="sessions-title">
      <div className="space-y-1">
        <h2 id="sessions-title" className="text-base font-semibold">
          Sessions
        </h2>
        <p className="text-sm text-text-muted">
          Devices signed in to your account. Revoke any you do not recognise.
        </p>
      </div>
      <ErrorAlert message={error} />
      {sessions === null && error === null && (
        <Spinner label="Loading sessions" />
      )}
      {sessions !== null && sessions.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              appName={appNames[session.clientId] ?? ''}
              connectedAppsHref={connectedAppsHref}
              busy={busy}
              onRevoke={() => void revoke(session)}
            />
          ))}
        </ul>
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
