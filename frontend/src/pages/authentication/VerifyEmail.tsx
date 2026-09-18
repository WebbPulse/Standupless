/**
 * The `/verify-email` page, which serves two behaviours on one path. A `?token=`
 * query means a mailed link landed here and `VerifyEmailToken` handles it;
 * anything else is a signed in user asking for a fresh email. The path is fixed
 * by `VERIFY_EMAIL_PATH` in the identity contract.
 */

import React, { useState } from 'react';
import { LINK_TOKEN_PARAM } from '@webbpulse/auth';
import { useSearchParams } from 'react-router-dom';
import AuthCard from '../../components/auth/AuthCard';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Spinner from '../../components/ui/spinner';
import { getIdentityClient } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';
import VerifyEmailToken from './VerifyEmailToken';

/** Routes `/verify-email` to the token confirmation or the request form. */
const VerifyEmail: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { user, isLoading } = useAuth();
  const client = getIdentityClient();
  const linkToken = searchParams.get(LINK_TOKEN_PARAM);

  const handleSend = async () => {
    setError(null);
    if (user === null || client === null) {
      setError('Sign in again, then request a new verification email.');
      return;
    }

    setIsSubmitting(true);
    try {
      const outcome = await client.requestEmailVerification({
        email: user.email,
      });
      if (outcome.ok) {
        setSentMessage(
          outcome.detail ?? 'Verification email sent. Check your inbox.'
        );
        return;
      }
      setError(outcome.message);
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (linkToken !== null && linkToken !== '') {
    return <VerifyEmailToken />;
  }

  if (isLoading) {
    return (
      <AuthCard title="Verify your email">
        <Spinner />
      </AuthCard>
    );
  }

  if (user === null) {
    return (
      <AuthCard title="Verify your email">
        <ErrorAlert message="Sign in to request a verification email." />
        <AuthRedirectLink text="Go to" linkText="Sign in" to="/login" />
      </AuthCard>
    );
  }

  if (user.email_verified && sentMessage === null) {
    return (
      <AuthCard title="Verify your email">
        <ConfirmationAlert message="Your email address is already verified." />
        <AuthRedirectLink
          text="Go to"
          linkText="your workspaces"
          to="/workspaces"
        />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Verify your email">
      <p className="text-center text-sm text-slate-400">
        Send a verification link to <strong>{user.email}</strong>.
      </p>
      <ConfirmationAlert message={sentMessage} />
      <ErrorAlert message={error} />
      {sentMessage === null && (
        <Button
          className="w-full"
          onClick={() => void handleSend()}
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Sending' : 'Send verification email'}
        </Button>
      )}
      <AuthRedirectLink
        text="Go to"
        linkText="your workspaces"
        to="/workspaces"
      />
    </AuthCard>
  );
};

export default VerifyEmail;
