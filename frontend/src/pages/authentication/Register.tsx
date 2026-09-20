/**
 * The account registration page.
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthCard from '../../components/auth/AuthCard';
import AuthForm from '../../components/auth/AuthForm';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Field from '../../components/ui/field';
import { getIdentityClient } from '../../api/identityClient';

/** Creates an account, then sends the new user to the sign in page. */
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
    <AuthCard title="Create an account">
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

        <Button
          type="submit"
          variant="primary"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Creating account' : 'Create account'}
        </Button>
      </AuthForm>

      <AuthRedirectLink
        text="Already have an account?"
        linkText="Sign in"
        to="/login"
      />
    </AuthCard>
  );
};

export default Register;
