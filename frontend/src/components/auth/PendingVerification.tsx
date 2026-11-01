/**
 * The screen a signed in account sees until its email address is confirmed.
 * It names the address the link went to, resends it on a cooldown, lets a
 * mistyped address be changed and offers sign out. Nothing behind it is
 * mounted, so no workspace call is made for an account the API would refuse.
 * The profile is read again whenever the tab regains focus and every half
 * minute, and the session token only rotates once it says verified, so opening
 * the link in another tab carries this one on without churning refresh tokens.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import AuthLayout from '../../pages/authentication/AuthLayout';
import AuthSubmitButton from '../../pages/authentication/AuthSubmitButton';
import { apiClient } from '../../api/client';
import { CURRENT_USER_PATH, getIdentityClient } from '../../api/identityClient';
import { recheckVerification } from '../../api/verification';
import { useAuth } from '../../hooks/useAuth';
import { useCooldown } from '../../hooks/useCooldown';
import { ConfirmationAlert, ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import EmailSection from '../account/EmailSection';
import type { UserRead } from '../../types/Api';

/** How often the profile is read while the screen is open. */
const VERIFICATION_POLL_MS = 30_000;

/** Says what to do next for an account whose email is not yet verified. */
const PendingVerification: React.FC = () => {
  const { user, logout, checkAuthStatus } = useAuth();
  const cooldown = useCooldown();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const checking = useRef(false);

  const recheck = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const { data } = await apiClient.get<UserRead>(CURRENT_USER_PATH);
      if (data.email_verified) await recheckVerification(checkAuthStatus);
    } catch {
      return;
    } finally {
      checking.current = false;
    }
  }, [checkAuthStatus]);

  useEffect(() => {
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') void recheck();
    };
    const timer = window.setInterval(onFocus, VERIFICATION_POLL_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [recheck]);

  if (user === null) return null;

  const resend = async (): Promise<void> => {
    const client = getIdentityClient();
    if (client === null || sending || cooldown.remaining > 0) return;
    setSending(true);
    setError(null);
    setSent(null);
    try {
      const outcome = await client.requestEmailVerification({
        email: user.email,
      });
      if (outcome.ok) {
        setSent(`We sent a new link to ${user.email}.`);
        cooldown.start();
        return;
      }
      setError(
        outcome.message === ''
          ? 'Could not send a new link. Try again in a few minutes.'
          : outcome.message
      );
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setSending(false);
    }
  };

  const resendLabel = sending
    ? 'Sending'
    : cooldown.remaining > 0
      ? `Resend in ${cooldown.remaining}s`
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
          disabled={sending || cooldown.remaining > 0}
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
