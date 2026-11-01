/**
 * The `/verify-email` page, which serves two behaviours on one path. A `?token=`
 * query means a mailed link landed here and `VerifyEmailToken` handles it;
 * anything else is a signed in user asking for a fresh email. The path is fixed
 * by `VERIFY_EMAIL_PATH` in the identity contract.
 */

import React, { useState } from 'react';
import { LINK_TOKEN_PARAM } from '@webbpulse/auth';
import { useEmailVerificationResend } from '@webbpulse/auth/react';
import { useSearchParams } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import AuthSubmitButton from './AuthSubmitButton';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import { getIdentityClient } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';
import VerifyEmailToken from './VerifyEmailToken';

/** Routes `/verify-email` to the token confirmation or the request form. */
const VerifyEmail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, isLoading } = useAuth();
  const client = getIdentityClient();
  const { send, sending, remaining } = useEmailVerificationResend({ client });
  const linkToken = searchParams.get(LINK_TOKEN_PARAM);

  const handleSend = async () => {
    setError(null);
    if (user === null || client === null) {
      setError('Sign in again, then request a new verification email.');
      return;
    }

    try {
      const outcome = await send(user.email);
      if (outcome === null) return;
      if (outcome.ok) {
        setSentMessage(
          outcome.detail ?? 'Verification email sent. Check your inbox.'
        );
        return;
      }
      setError(outcome.message);
    } catch {
      setError('Could not reach the server. Check your connection.');
    }
  };

  if (linkToken !== null && linkToken !== '') {
    return <VerifyEmailToken />;
  }

  if (isLoading) {
    return (
      <AuthLayout title="Verify your email">
        <Spinner />
      </AuthLayout>
    );
  }

  if (user === null) {
    return (
      <AuthLayout title="Verify your email">
        <ErrorAlert message="Sign in to request a verification email." />
        <AuthRedirectLink text="Go to" linkText="Sign in" to="/login" />
      </AuthLayout>
    );
  }

  if (user.email_verified && sentMessage === null) {
    return (
      <AuthLayout title="Verify your email">
        <ConfirmationAlert message="Your email address is already verified." />
        <AuthRedirectLink
          text="Go to"
          linkText="your workspaces"
          to="/workspaces"
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Verify your email">
      <p className="text-sm text-text-muted">
        Send a verification link to <strong>{user.email}</strong>.
      </p>
      <ConfirmationAlert message={sentMessage} />
      <ErrorAlert message={error} />
      <AuthSubmitButton
        onClick={() => void handleSend()}
        disabled={sending || remaining > 0}
      >
        {sending
          ? 'Sending'
          : remaining > 0
            ? `Resend in ${remaining}s`
            : sentMessage === null
              ? 'Send verification email'
              : 'Resend verification email'}
      </AuthSubmitButton>
      <AuthRedirectLink
        text="Go to"
        linkText="your workspaces"
        to="/workspaces"
      />
    </AuthLayout>
  );
};

export default VerifyEmail;
