/**
 * Spends a mailed verification token, which `useEmailVerificationLink` does
 * exactly once even under the StrictMode double mount.
 */

import React from 'react';
import { useEmailVerificationLink } from '@webbpulse/auth/react';
import AuthLayout from './AuthLayout';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import { getIdentityClient } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';

/** The sentence for each refusal, used when the server sent none of its own. */
const REFUSAL_FALLBACKS: Record<string, string> = {
  'invalid-link':
    'This link is no longer valid. Verification links expire and can only be used once.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
  unavailable:
    'Email is not configured for this deployment, so verification links cannot be sent.',
};

/** Reports the outcome of spending a verification token. */
const VerifyEmailToken: React.FC = () => {
  const { checkAuthStatus } = useAuth();
  const state = useEmailVerificationLink({
    client: getIdentityClient(),
    onConfirmed: checkAuthStatus,
  });

  return (
    <AuthLayout title="Verify your email">
      {state.kind === 'confirming' && <Spinner label="Verifying" />}
      {state.kind === 'confirmed' && (
        <>
          <ConfirmationAlert message="Your email address is verified." />
          <AuthRedirectLink
            text="Go to"
            linkText="your workspaces"
            to="/workspaces"
          />
        </>
      )}
      {state.kind === 'missing-token' && (
        <>
          <ErrorAlert message="This link is missing its token. Request a new one." />
          <AuthRedirectLink
            text="Go to"
            linkText="your workspaces"
            to="/workspaces"
          />
        </>
      )}
      {state.kind === 'refused' && (
        <>
          <ErrorAlert
            message={
              state.message === ''
                ? (REFUSAL_FALLBACKS[state.reason] ??
                  'That verification link could not be used.')
                : state.message
            }
          />
          <AuthRedirectLink
            text="Go to"
            linkText="your workspaces"
            to="/workspaces"
          />
        </>
      )}
      {state.kind === 'failed' && (
        <>
          <ErrorAlert message="Could not reach the server. Check your connection and open the link again." />
          <AuthRedirectLink
            text="Go to"
            linkText="your workspaces"
            to="/workspaces"
          />
        </>
      )}
    </AuthLayout>
  );
};

export default VerifyEmailToken;
