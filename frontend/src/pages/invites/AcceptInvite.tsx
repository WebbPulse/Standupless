/**
 * Redeems an invite token from the query string. The route is not behind
 * `ProtectedRoute`: a signed-out person following an invite link is sent to
 * login with a `returnTo` back to this page, so the token survives the round
 * trip and is redeemed once they land back here signed in.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { acceptInvite, listWorkspaces } from '../../api/workspaces';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import TextLink from '../../components/ui/link';
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
      <main className="flex min-h-screen flex-col items-center px-4 pt-[20vh] pb-12 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="text-xl font-semibold">Invite link</h1>
          <p className="text-sm text-text-muted">
            This link is missing its invite token. Ask whoever invited you to
            send it again.
          </p>
        </div>
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
    <AccountShell width="narrow">
      <div className="space-y-5 rounded-lg border border-line bg-bg p-6">
        <h1 className="text-lg font-semibold">Accept invite</h1>

        {state === 'accepting' && <Spinner label="Accepting your invite" />}

        {state === 'failed' && (
          <>
            <ErrorAlert message={message} />
            <p className="text-sm text-text-muted">
              <TextLink to="/workspaces">Go to your workspaces</TextLink>
            </p>
          </>
        )}

        {state === 'accepted' && (
          <>
            <p role="status" className="text-sm text-text">
              You have joined
              {workspace === null ? ' the workspace' : ` ${workspace.name}`}.
            </p>
            <p className="text-sm text-text-muted">
              <TextLink
                to={workspace === null ? '/workspaces' : `/w/${workspace.slug}`}
              >
                {workspace === null
                  ? 'Go to your workspaces'
                  : 'Open the workspace'}
              </TextLink>
            </p>
          </>
        )}
      </div>
    </AccountShell>
  );
};

export default AcceptInvite;
