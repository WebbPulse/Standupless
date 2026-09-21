/**
 * Landing page for a mailed password reset link. The token is read at render
 * against `RESET_PASSWORD_PATH`, so a verification token cannot be presented
 * here, and spent on submit.
 */

import React, { useState } from 'react';
import { RESET_PASSWORD_PATH, readLinkToken } from '@webbpulse/auth';
import AuthLayout from './AuthLayout';
import AuthSubmitButton from './AuthSubmitButton';
import AuthForm from '../../components/auth/AuthForm';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Field from '../../components/ui/field';
import { getIdentityClient } from '../../api/identityClient';

/**
 * The sentence shown for each refusal the package models, used only when the
 * server sent none of its own.
 */
const REFUSAL_FALLBACKS: Record<string, string> = {
  'invalid-link':
    'This link is no longer valid. Reset links expire and can only be used once. Request a new one.',
  'password-rejected':
    'That password was rejected. Choose a longer or less common one, then request a new link.',
  'rate-limited':
    'Too many attempts. Wait a few minutes, then request a new reset link.',
  unavailable:
    'Email is not configured for this deployment, so reset links cannot be sent.',
};

/** Reads the token from the link, takes a new password, and spends the token. */
const ResetPassword: React.FC = () => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const client = getIdentityClient();
  const token = readLinkToken({ expectedPath: RESET_PASSWORD_PATH });

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (token === null) {
      setError('This link is missing its token. Request a new one.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setError('The two passwords do not match.');
      return;
    }
    if (newPassword.trim() === '') {
      setError('Enter a new password.');
      return;
    }
    if (client === null) {
      setError('Password reset is not available in this deployment.');
      return;
    }

    setIsSubmitting(true);
    try {
      const outcome = await client.confirmPasswordReset({
        token,
        newPassword,
      });
      if (outcome.ok) {
        setIsDone(true);
        return;
      }
      setError(
        outcome.message === ''
          ? (REFUSAL_FALLBACKS[outcome.reason] ??
              'That reset link could not be used.')
          : outcome.message
      );
    } catch {
      setError('Could not reach the server. Check your connection.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (client === null) {
    return (
      <AuthLayout title="Set a new password">
        <ErrorAlert message="Password reset is not available in this deployment." />
        <AuthRedirectLink text="Go to" linkText="Sign in" to="/login" />
      </AuthLayout>
    );
  }

  if (token === null) {
    return (
      <AuthLayout title="Set a new password">
        <ErrorAlert message="No reset token found in this link. Request a new one." />
        <AuthRedirectLink
          text="Request a"
          linkText="new reset link"
          to="/forgot-password"
        />
      </AuthLayout>
    );
  }

  if (isDone) {
    return (
      <AuthLayout title="Set a new password">
        <ConfirmationAlert message="Your new password is set, and every other session has been signed out. You can sign in now." />
        <AuthRedirectLink text="Go to" linkText="Sign in" to="/login" />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Set a new password">
      <AuthForm onSubmit={(event) => void handleSubmit(event)}>
        <Field
          id="new-password"
          label="New password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          disabled={isSubmitting}
        />
        <Field
          id="confirm-new-password"
          label="Confirm new password"
          name="confirm-new-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmNewPassword}
          onChange={(event) => setConfirmNewPassword(event.target.value)}
          disabled={isSubmitting}
        />

        <ErrorAlert message={error} />

        <AuthSubmitButton type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Setting password' : 'Set new password'}
        </AuthSubmitButton>
      </AuthForm>

      <AuthRedirectLink text="Remembered it?" linkText="Sign in" to="/login" />
    </AuthLayout>
  );
};

export default ResetPassword;
