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
 */

import React, { useState } from 'react';
import { LuShieldAlert } from 'react-icons/lu';
import { getIdentityClient } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';
import { listSignInMethods } from '../../lib/signInMethods';
import AccountShell from '../layout/AccountShell';
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
  const [checking, setChecking] = useState(false);
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

  return (
    <AccountShell width="narrow">
      <div className="space-y-4" data-testid="auth-policy-gate">
        <LuShieldAlert className="h-6 w-6 text-text-faint" aria-hidden="true" />
        {methodRefused ? (
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
