/**
 * Requests a password reset link for an email address.
 */

import React, { useState } from 'react';
import AuthLayout from './AuthLayout';
import AuthSubmitButton from './AuthSubmitButton';
import AuthForm from '../../components/auth/AuthForm';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Field from '../../components/ui/field';
import { getIdentityClient } from '../../api/identityClient';

/**
 * Takes an address and asks for a reset link. The request route never says
 * whether the address exists, so the server's own sentence is rendered verbatim.
 */
const ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState('');
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const client = getIdentityClient();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (email.trim() === '') {
      setError('Enter an email address.');
      return;
    }
    if (client === null) {
      setError('Password reset is not available in this deployment.');
      return;
    }

    setIsSubmitting(true);
    try {
      const outcome = await client.requestPasswordReset({
        email: email.trim(),
      });
      if (outcome.ok) {
        setSentMessage(
          outcome.detail ??
            'If an account with that address exists, a reset link is on its way.'
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

  if (sentMessage !== null) {
    return (
      <AuthLayout title="Reset your password">
        <ConfirmationAlert message={sentMessage} />
        <AuthRedirectLink
          text="Remembered it?"
          linkText="Sign in"
          to="/login"
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter your email address and we will send a reset link."
    >
      <AuthForm onSubmit={(event) => void handleSubmit(event)}>
        <Field
          id="email"
          label="Email address"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={isSubmitting}
        />

        <ErrorAlert message={error} />

        <AuthSubmitButton type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Sending' : 'Send reset link'}
        </AuthSubmitButton>
      </AuthForm>

      <AuthRedirectLink text="Remembered it?" linkText="Sign in" to="/login" />
    </AuthLayout>
  );
};

export default ForgotPassword;
