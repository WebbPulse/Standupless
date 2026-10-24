/**
 * The signed in person's live sessions, most recently active first, with the
 * one in this browser marked and every other one revocable. Revoking ends that
 * sign-in at its next refresh. The current session is ended by signing out,
 * so it has no revoke button.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { AccountSession } from '@webbpulse/auth';
import { LuMonitor, LuSmartphone, LuBot, LuGlobe } from 'react-icons/lu';
import {
  getIdentityClient,
  type IdentityClient,
} from '../../api/identityClient';
import { deviceLabel } from '../../lib/account';
import { signInMethodLabel } from '../../lib/amr';
import { errorMessage } from '../../lib/errors';
import { showErrorToast, showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';

/** The icon for a device class. */
const DeviceIcon: React.FC<{ device: string }> = ({ device }) => {
  const className = 'h-4 w-4 shrink-0 text-text-muted';
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
  busy: boolean;
  onRevoke: () => void;
}> = ({ session, busy, onRevoke }) => {
  const method = signInMethodLabel(session.amr);
  return (
    <li
      className="flex min-h-row items-center gap-3 px-3 py-2"
      data-testid="session-row"
    >
      <DeviceIcon device={session.device} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text">
            {deviceLabel(session.device)}
          </span>
          {session.current && <Badge tone="accent">This session</Badge>}
        </div>
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-faint">
          {method !== '' && <span>{method}</span>}
          {session.ip !== '' && <span>{session.ip}</span>}
          {session.lastActiveAt !== '' && (
            <span className="inline-flex items-center gap-1">
              Last active <RelativeTime value={session.lastActiveAt} />
            </span>
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

/** The list, mounted only once a client exists. */
const SessionList: React.FC<{ client: IdentityClient }> = ({ client }) => {
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
              busy={busy}
              onRevoke={() => void revoke(session)}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/** Renders the sessions section, or nothing when no identity client could be built. */
const SessionsSection: React.FC = () => {
  const client = getIdentityClient();
  if (client === null) return null;
  return <SessionList client={client} />;
};

export default SessionsSection;
