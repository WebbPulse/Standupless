/**
 * Redeems an invite token from the query string. The route is not behind
 * `ProtectedRoute`: a signed-out person following an invite link is sent to
 * login with a `returnTo` back to this page, so the token survives the round
 * trip and is redeemed once they land back here signed in.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { acceptInvite, listWorkspaces } from '../../api/workspaces';
import { ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/errors';
import type { WorkspaceRead } from '../../types/Api';

/** What the redemption is doing right now. */
type AcceptState = 'accepting' | 'accepted' | 'failed';

/**
 * Accepts the invite once the session has settled, then points at the
 * workspace it joined.
 */
const AcceptInvite: React.FC = () => {
  const [params] = useSearchParams();
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const token = params.get('token');
  const attempted = useRef(false);
  const [state, setState] = useState<AcceptState>('accepting');
  const [message, setMessage] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceRead | null>(null);

  useEffect(() => {
    if (isLoading || !isAuthenticated || token === null) return;
    if (attempted.current) return;
    attempted.current = true;

    const controller = new AbortController();
    const before = listWorkspaces(controller.signal).catch(
      (): WorkspaceRead[] => []
    );

    before
      .then(async (existing) => {
        await acceptInvite(token);
        const after = await listWorkspaces(controller.signal);
        if (controller.signal.aborted) return;
        const known = new Set(existing.map((item) => item.id));
        setWorkspace(after.find((item) => !known.has(item.id)) ?? null);
        setState('accepted');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setMessage(
          errorMessage(
            error,
            'That invite could not be accepted. It may have expired or been revoked.'
          )
        );
        setState('failed');
      });

    return () => {
      controller.abort();
    };
  }, [isLoading, isAuthenticated, token]);

  if (token === null) {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 py-12">
        <h1 className="text-2xl font-semibold text-white">Invite link</h1>
        <p className="text-sm text-slate-400">
          This link is missing its invite token. Ask whoever invited you to send
          it again.
        </p>
      </main>
    );
  }

  if (isLoading) {
    return <Spinner label="Checking your session" />;
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`;
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }

  return (
    <main className="mx-auto max-w-md space-y-4 px-4 py-12">
      <h1 className="text-2xl font-semibold text-white">Accept invite</h1>

      {state === 'accepting' && <Spinner label="Accepting your invite" />}

      {state === 'failed' && (
        <>
          <ErrorAlert message={message} />
          <p className="text-sm text-slate-400">
            <Link to="/workspaces" className="text-sky-400 hover:text-sky-300">
              Go to your workspaces
            </Link>
          </p>
        </>
      )}

      {state === 'accepted' && (
        <>
          <p role="status" className="text-sm text-slate-300">
            You have joined
            {workspace === null ? ' the workspace' : ` ${workspace.name}`}.
          </p>
          <p className="text-sm text-slate-400">
            <Link
              to={workspace === null ? '/workspaces' : `/w/${workspace.slug}`}
              className="text-sky-400 hover:text-sky-300"
            >
              {workspace === null
                ? 'Go to your workspaces'
                : 'Open the workspace'}
            </Link>
          </p>
        </>
      )}
    </main>
  );
};

export default AcceptInvite;
