/**
 * What a member sees in place of a workspace whose authentication policy their
 * session does not meet. Every workspace route would answer 403, so the page
 * explains why and points at the one place that fixes it.
 *
 * "Try again" refreshes the session before re-reading the workspace list,
 * because the `two_factor` claim the policy checks is stamped at refresh.
 */

import React, { useState } from 'react';
import { LuShieldAlert } from 'react-icons/lu';
import { getIdentityClient } from '../../api/identityClient';
import AccountShell from '../layout/AccountShell';
import Button from '../ui/button';
import TextLink from '../ui/link';
import type { WorkspaceRead } from '../../types/Api';

/** Props for AuthPolicyGate: the blocked workspace and how to re-read it. */
export interface AuthPolicyGateProps {
  workspace: WorkspaceRead;
  onRetry: () => Promise<void>;
}

/** Explains the two-factor requirement and offers to check again. */
export const AuthPolicyGate: React.FC<AuthPolicyGateProps> = ({
  workspace,
  onRetry,
}) => {
  const [checking, setChecking] = useState(false);

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
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">
            {workspace.name} requires two-factor authentication
          </h1>
          <p className="text-sm text-text-muted">
            An admin turned this on for everyone in the workspace. Set up an
            authenticator app on your account to get back in.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <TextLink to="/security">Set up two-factor authentication</TextLink>
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
        <p className="text-sm text-text-muted">
          <TextLink to="/workspaces">Back to your workspaces</TextLink>
        </p>
      </div>
    </AccountShell>
  );
};

export default AuthPolicyGate;
