/**
 * What a member sees in place of a workspace whose authentication policy their
 * session does not meet. Every workspace route would answer 403, so the page
 * explains why and points at the one thing that fixes it.
 *
 * A missing second factor is fixed on the account security page, and "Try
 * again" refreshes the session before re-reading the workspace list, because
 * the `two_factor` claim the policy checks is stamped at refresh. A refused
 * sign-in method is fixed only by signing in again another way, so that page
 * names the allowed methods and offers to sign out.
 *
 * A single sign-on requirement is met only by a session from the workspace's
 * own connection, so that page starts one, signing the current session out
 * on the way and returning to the page the member was on.
 */

import React, { useState } from 'react';
import { LuShieldAlert } from 'react-icons/lu';
import { getIdentityClient } from '../../api/identityClient';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { errorMessage } from '../../lib/errors';
import { listSignInMethods } from '../../lib/signInMethods';
import { beginSso } from '../../lib/sso';
import AccountShell from '../layout/AccountShell';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import TextLink from '../ui/link';
import type { WorkspaceRead } from '../../types/Api';

/** Props for AuthPolicyGate: the blocked workspace and how to re-read it. */
export interface AuthPolicyGateProps {
  workspace: WorkspaceRead;
  onRetry: () => Promise<void>;
}

/** Explains which part of the policy the session misses and how to meet it. */
export const AuthPolicyGate: React.FC<AuthPolicyGateProps> = ({
  workspace,
  onRetry,
}) => {
  const { logout } = useAuth();
  const location = useLocation();
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const ssoRequired = workspace.auth_policy_reason === 'sso';
  const allowed = workspace.auth_policy_allowed_methods ?? [];
  const methodRefused =
    workspace.auth_policy_reason === 'sign_in_method' && allowed.length > 0;

  const retry = async (): Promise<void> => {
    setChecking(true);
    try {
      await getIdentityClient()?.refresh();
      await onRetry();
    } finally {
      setChecking(false);
    }
  };

  const continueWithSso = async (): Promise<void> => {
    setStarting(true);
    setSsoError(null);
    try {
      await beginSso({
        connectionId: workspace.id,
        returnTo: `${location.pathname}${location.search}`,
        signOut: () => logout(),
      });
    } catch (error) {
      setStarting(false);
      setSsoError(
        errorMessage(error, 'Could not start single sign-on. Try again.')
      );
    }
  };

  return (
    <AccountShell width="narrow">
      <div className="space-y-4" data-testid="auth-policy-gate">
        <LuShieldAlert className="h-6 w-6 text-text-faint" aria-hidden="true" />
        {ssoRequired ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {workspace.name} requires single sign-on
              </h1>
              <p className="text-sm text-text-muted">
                An admin requires everyone in this workspace to sign in through
                its identity provider. Continue with SSO to sign out of this
                session and sign in again there.
              </p>
            </div>
            <ErrorAlert message={ssoError} />
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                disabled={starting}
                onClick={() => {
                  void continueWithSso();
                }}
                data-testid="auth-policy-sso"
              >
                {starting ? 'Opening single sign-on' : 'Continue with SSO'}
              </Button>
            </div>
          </>
        ) : methodRefused ? (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {workspace.name} only allows signing in with{' '}
                {listSignInMethods(allowed)}
              </h1>
              <p className="text-sm text-text-muted">
                An admin limited the ways people can sign in to this workspace,
                and your current session used another one. Sign out, then sign
                in with {listSignInMethods(allowed)} to get back in.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void logout()}
                data-testid="auth-policy-sign-out"
              >
                Sign out and sign in again
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">
                {workspace.name} requires two-factor authentication
              </h1>
              <p className="text-sm text-text-muted">
                An admin turned this on for everyone in the workspace. Add an
                authenticator app or a passkey to your account to get back in.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <TextLink to="/security">
                Set up two-factor authentication
              </TextLink>
              <Button
                variant="secondary"
                size="sm"
                disabled={checking}
                onClick={() => {
                  void retry();
                }}
              >
                {checking ? 'Checking' : 'Try again'}
              </Button>
            </div>
          </>
        )}
        <p className="text-sm text-text-muted">
          <TextLink to="/workspaces">Back to your workspaces</TextLink>
        </p>
      </div>
    </AccountShell>
  );
};

export default AuthPolicyGate;
