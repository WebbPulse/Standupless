/**
 * The account registration page.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import AuthSubmitButton from './AuthSubmitButton';
import AuthForm from '../../components/auth/AuthForm';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ErrorAlert } from '../../components/ui/alert';
import Field from '../../components/ui/field';
import TextLink from '../../components/ui/link';
import { PRIVACY_PATH, TERMS_PATH } from '../../lib/paths';
import { getIdentityClient } from '../../api/identityClient';

/**
 * Creates an account, then sends the new user to the sign in page. The line
 * above the button links the terms and privacy policy the account is made under.
 */
const Register: React.FC = () => {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const client = getIdentityClient();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (email.trim() === '' || password === '') {
      setError('Enter an email address and a password.');
      return;
    }
    if (password !== confirmPassword) {
      setError('The two passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Use a password of at least 8 characters.');
      return;
    }
    if (client === null) {
      setError('Registration is not available in this deployment.');
      return;
    }

    setIsSubmitting(true);
    try {
      await client.register({
        email: email.trim(),
        password,
        display_name: displayName.trim() === '' ? null : displayName.trim(),
      });
      void navigate('/login');
    } catch {
      setError('That account could not be created. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title="Create an account"
      subtitle="Set up an account, then create or join a workspace."
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
        <Field
          id="display-name"
          label="Display name"
          name="display-name"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          disabled={isSubmitting}
        />
        <Field
          id="password"
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={isSubmitting}
        />
        <Field
          id="confirm-password"
          label="Confirm password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          disabled={isSubmitting}
        />

        <ErrorAlert message={error} />

        <p className="text-xs text-text-muted" data-testid="register-agreement">
          By signing up you agree to the{' '}
          <TextLink to={TERMS_PATH}>Terms of Service</TextLink> and the{' '}
          <TextLink to={PRIVACY_PATH}>Privacy Policy</TextLink>.
        </p>

        <AuthSubmitButton type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating account' : 'Create account'}
        </AuthSubmitButton>
      </AuthForm>

      <AuthRedirectLink
        text="Already have an account?"
        linkText="Sign in"
        to="/login"
      />
    </AuthLayout>
  );
};

export default Register;
