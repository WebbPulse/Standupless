/**
 * Spends a mailed verification token, which `useEmailVerificationLink` does
 * exactly once even under the StrictMode double mount.
 */

import React, { useEffect, useRef } from 'react';
import { useEmailVerificationLink } from '@webbpulse/auth/react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import { getIdentityClient } from '../../api/identityClient';
import { recheckVerification } from '../../api/verification';
import { useAuth } from '../../hooks/useAuth';

/** The sentence for each refusal, used when the server sent none of its own. */
const REFUSAL_FALLBACKS: Record<string, string> = {
  'invalid-link':
    'This link is no longer valid. Verification links expire and can only be used once.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
  unavailable:
    'Email is not configured for this deployment, so verification links cannot be sent.',
};

/** Where a verified, signed in person is carried on to. */
const CONTINUE_PATH = '/workspaces';

/**
 * Reports the outcome of spending a verification token. A browser that holds
 * the session moves on to the workspaces by itself once the address is
 * confirmed, with a token that carries it, so onboarding starts without a
 * second sign in. A browser without one, such as a phone opening the mail, is
 * asked to sign in, because the link alone never signs anyone in. A link that
 * was already spent, often by a mail scanner opening it first, is no failure
 * for an account that is now verified, and with no session to tell whether it
 * is, the page says so plainly and asks for a sign in.
 */
const VerifyEmailToken: React.FC = () => {
  const { isAuthenticated, isLoading, user, checkAuthStatus } = useAuth();
  const navigate = useNavigate();
  const state = useEmailVerificationLink({ client: getIdentityClient() });
  const continued = useRef(false);
  const spentLink = state.kind === 'refused' && state.reason === 'invalid-link';
  const alreadyVerified = spentLink && user?.email_verified === true;
  const settled = state.kind === 'confirmed' || alreadyVerified;
  const signedIn = !isLoading && isAuthenticated;

  useEffect(() => {
    if (!settled || !signedIn || continued.current) return;
    continued.current = true;
    void recheckVerification(checkAuthStatus).then(() => {
      void navigate(CONTINUE_PATH, { replace: true });
    });
  }, [settled, signedIn, checkAuthStatus, navigate]);

  if (state.kind === 'confirming' || ((settled || spentLink) && isLoading)) {
    return (
      <AuthLayout title="Verify your email">
        <Spinner label="Verifying" />
      </AuthLayout>
    );
  }

  if (settled) {
    return (
      <AuthLayout title="Email verified">
        <ConfirmationAlert message="Your email address is verified." />
        {signedIn ? (
          <Spinner label="Opening your workspaces" />
        ) : (
          <AuthRedirectLink
            text="To continue,"
            linkText="sign in"
            to="/login"
          />
        )}
      </AuthLayout>
    );
  }

  if (spentLink && !signedIn) {
    return (
      <AuthLayout title="Verify your email">
        <p className="text-sm text-text">
          This link has already been used or has expired. If your address is not
          confirmed yet, you can send a new link after signing in.
        </p>
        <AuthRedirectLink text="To continue," linkText="sign in" to="/login" />
      </AuthLayout>
    );
  }

  const next = signedIn ? (
    <AuthRedirectLink
      text="Go to"
      linkText="your workspaces"
      to="/workspaces"
    />
  ) : (
    <AuthRedirectLink text="Already verified?" linkText="Sign in" to="/login" />
  );

  return (
    <AuthLayout title="Verify your email">
      {state.kind === 'missing-token' && (
        <ErrorAlert message="This link is missing its token. Request a new one." />
      )}
      {state.kind === 'refused' && (
        <ErrorAlert
          message={
            state.message === ''
              ? (REFUSAL_FALLBACKS[state.reason] ??
                'That verification link could not be used.')
              : state.message
          }
        />
      )}
      {state.kind === 'failed' && (
        <ErrorAlert message="Could not reach the server. Check your connection and open the link again." />
      )}
      {next}
    </AuthLayout>
  );
};

export default VerifyEmailToken;
