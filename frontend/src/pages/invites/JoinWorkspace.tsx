/**
 * The page a workspace invite link opens. The route sits outside
 * `ProtectedRoute` so a signed-out visitor sees what the link is for and can
 * sign in or create an account, each carrying a `returnTo` back here so the
 * token survives the round trip. Signed in, the page names the workspace the
 * link joins and adds the visitor as a member when they choose to join.
 */

import React, { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { joinInviteLink, previewInviteLink } from '../../api/workspaces';
import AccountShell from '../../components/layout/AccountShell';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import TextLink from '../../components/ui/link';
import Spinner from '../../components/ui/spinner';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/errors';
import type { InviteLinkPreview } from '../../types/Api';

/** The fallback wording for a link that opens no workspace. */
const DEAD_LINK =
  'This invite link is not valid. It may have been reset or turned off.';

/** Names the workspace behind the link and joins it on request. */
const JoinWorkspace: React.FC = () => {
  const [params] = useSearchParams();
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const token = params.get('token');
  const [preview, setPreview] = useState<InviteLinkPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (isLoading || !isAuthenticated || token === null) return;
    let cancelled = false;
    previewInviteLink(token)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error, DEAD_LINK));
      });
    return () => {
      cancelled = true;
    };
  }, [isLoading, isAuthenticated, token]);

  if (token === null) {
    return (
      <main className="flex min-h-screen flex-col items-center px-4 pt-[20vh] pb-12 text-center">
        <div className="max-w-sm space-y-2">
          <h1 className="text-xl font-semibold">Invite link</h1>
          <p className="text-sm text-text-muted">
            This link is missing its invite token. Ask whoever shared it to send
            it again.
          </p>
        </div>
      </main>
    );
  }

  if (isLoading) {
    return <Spinner label="Checking your session" />;
  }

  if (!isAuthenticated) {
    const returnTo = encodeURIComponent(
      `${location.pathname}${location.search}`
    );
    return (
      <AccountShell width="narrow">
        <div className="space-y-5 rounded-lg border border-line bg-bg p-6">
          <h1 className="text-lg font-semibold">Join a workspace</h1>
          <p className="text-sm text-text-muted">
            You have been invited to join a workspace. Sign in or create an
            account to continue.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to={`/login?returnTo=${returnTo}`}
              className="inline-flex h-8 items-center rounded-sm border border-transparent bg-accent px-3 text-sm font-medium text-on-accent hover:bg-accent-strong"
            >
              Sign in
            </Link>
            <Link
              to={`/register?returnTo=${returnTo}`}
              className="inline-flex h-8 items-center rounded-sm border border-line-strong bg-bg px-3 text-sm font-medium text-text hover:bg-raised"
            >
              Create an account
            </Link>
          </div>
        </div>
      </AccountShell>
    );
  }

  const onJoin = (): void => {
    setJoining(true);
    setJoinError(null);
    joinInviteLink(token)
      .then(() => {
        setJoined(true);
      })
      .catch((error: unknown) => {
        setJoinError(
          errorMessage(error, 'Could not join the workspace. Try again.')
        );
      })
      .finally(() => {
        setJoining(false);
      });
  };

  return (
    <AccountShell width="narrow">
      <div className="space-y-5 rounded-lg border border-line bg-bg p-6">
        <h1 className="text-lg font-semibold">Join a workspace</h1>

        {loadError !== null && (
          <>
            <ErrorAlert message={loadError} />
            <p className="text-sm text-text-muted">
              <TextLink to="/workspaces">Go to your workspaces</TextLink>
            </p>
          </>
        )}

        {loadError === null && preview === null && (
          <Spinner label="Checking the invite link" />
        )}

        {preview !== null && (joined || preview.already_member) && (
          <>
            <p role="status" className="text-sm text-text">
              {joined
                ? `You have joined ${preview.name}.`
                : `You are already a member of ${preview.name}.`}
            </p>
            <p className="text-sm text-text-muted">
              <TextLink to={`/w/${preview.slug}`}>Open the workspace</TextLink>
            </p>
          </>
        )}

        {preview !== null && !joined && !preview.already_member && (
          <>
            <p className="text-sm text-text">
              You have been invited to join{' '}
              <span className="font-medium">{preview.name}</span> as a member.
            </p>
            {joinError !== null && <ErrorAlert message={joinError} />}
            <Button variant="primary" disabled={joining} onClick={onJoin}>
              {joining ? 'Joining' : `Join ${preview.name}`}
            </Button>
          </>
        )}
      </div>
    </AccountShell>
  );
};

export default JoinWorkspace;
