/**
 * The screen a signed in account sees until its email address is confirmed.
 * It names the address the link went to, resends it on a cooldown, lets a
 * mistyped address be changed and offers sign out. Nothing behind it is
 * mounted, so no workspace call is made for an account the API would refuse.
 * The profile is read again whenever the tab regains focus and every half
 * minute, and the session token only rotates once it says verified, so opening
 * the link in another tab carries this one on without churning refresh tokens.
 */

import React, { useState } from 'react';
import {
  useEmailVerificationResend,
  useEmailVerificationWatch,
} from '@webbpulse/auth/react';
import AuthLayout from '../../pages/authentication/AuthLayout';
import AuthSubmitButton from '../../pages/authentication/AuthSubmitButton';
import { apiClient } from '../../api/client';
import { CURRENT_USER_PATH, getIdentityClient } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import EmailSection from '../account/EmailSection';
import type { UserRead } from '../../types/Api';

/** Says what to do next for an account whose email is not yet verified. */
const PendingVerification: React.FC = () => {
  const { user, logout } = useAuth();
  const client = getIdentityClient();
  const { send, sending, remaining } = useEmailVerificationResend({ client });
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  useEmailVerificationWatch({
    client,
    enabled: user?.email_verified === false,
    isVerified: async () => {
      const { data } = await apiClient.get<UserRead>(CURRENT_USER_PATH);
      return data.email_verified;
    },
  });

  if (user === null) return null;

  const resend = async (): Promise<void> => {
    setError(null);
    setSent(null);
    try {
      const outcome = await send(user.email);
      if (outcome === null) return;
      if (outcome.ok) {
        setSent(`We sent a new link to ${user.email}.`);
        return;
      }
      setError(
        outcome.message === ''
          ? 'Could not send a new link. Try again in a few minutes.'
          : outcome.message
      );
    } catch {
      setError('Could not reach the server. Check your connection.');
    }
  };

  const resendLabel = sending
    ? 'Sending'
    : remaining > 0
      ? `Resend in ${remaining}s`
      : 'Resend verification email';

  return (
    <AuthLayout
      title="Check your email"
      subtitle="Confirm your email address to finish setting up your account."
    >
      <div data-testid="pending-verification" className="space-y-5">
        <p className="text-sm text-text">
          We sent a verification link to{' '}
          <strong data-testid="pending-verification-email">{user.email}</strong>
          . Open it on this device to continue. This page carries on by itself
          once the address is confirmed.
        </p>
        <ConfirmationAlert message={sent} />
        <ErrorAlert message={error} />
        <AuthSubmitButton
          onClick={() => void resend()}
          disabled={sending || remaining > 0}
        >
          {resendLabel}
        </AuthSubmitButton>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChanging((open) => !open)}
            aria-expanded={changing}
          >
            {changing ? 'Keep this email' : 'Use a different email'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
        {changing && <EmailSection />}
      </div>
    </AuthLayout>
  );
};

export default PendingVerification;
