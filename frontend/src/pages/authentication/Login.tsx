/**
 * The sign in page: password, passkey and OAuth, with the TOTP second leg.
 */

import React, { useState } from 'react';
import {
  describeOAuthCallbackError,
  type PasskeySignInOutcome,
} from '@webbpulse/auth';
import {
  useAuth as usePackageAuth,
  useOAuthCallback,
} from '@webbpulse/auth/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import AuthSubmitButton from './AuthSubmitButton';
import AuthForm from '../../components/auth/AuthForm';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import OAuthProviderButtons from '../../components/auth/OAuthProviderButtons';
import PasskeySignInButton from '../../components/auth/PasskeySignInButton';
import { ErrorAlert } from '../../components/ui/alert';
import Field from '../../components/ui/field';
import TextLink from '../../components/ui/link';
import { useAuth } from '../../hooks/useAuth';
import type { UserRead } from '../../types/Api';

/**
 * Only accept returnTo values that look like a local path, so a crafted
 * `/login?returnTo=` link cannot be used as an open redirect.
 */
const safeReturnTo = (value: string | null): string => {
  if (value === null || value === '') return '/workspaces';
  if (!value.startsWith('/') || value.startsWith('//')) return '/workspaces';
  return value;
};

/** Signs a user in with a password, a passkey or a provider. */
const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'));
  const { login: seedUser, checkAuthStatus } = useAuth();
  const { login, completeTotp } = usePackageAuth<UserRead>();

  /**
   * Finishes a sign in that already succeeded on the server, fetching the user
   * the token does not carry when the outcome did not embed one.
   */
  const finishLogin = async (user: UserRead | null) => {
    if (user !== null) {
      seedUser(user);
    } else {
      await checkAuthStatus();
    }
    void navigate(returnTo);
  };

  useOAuthCallback(async (result) => {
    if (result.kind === 'signed-in' || result.kind === 'linked') {
      await finishLogin(null);
      return;
    }
    if (result.kind === 'mfa-required') {
      setTicket(result.ticket);
      return;
    }
    setError(
      describeOAuthCallbackError(result, 'That sign in could not be completed.')
    );
  });

  /** Finishes a passwordless sign in, or shows why it did not finish. */
  const handlePasskeyResult = async (result: PasskeySignInOutcome) => {
    if (!result.ok) {
      if (result.reason !== 'cancelled') setError(result.message);
      return;
    }
    if (result.kind === 'mfa-required') {
      setTicket(result.ticket);
      setError(null);
      return;
    }
    await finishLogin((result.user as UserRead | null) ?? null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (ticket !== null) {
      if (code.trim() === '') {
        setError('Enter the code from your authenticator app.');
        return;
      }
      setIsSubmitting(true);
      try {
        const outcome = await completeTotp({ ticket, code: code.trim() });
        if (!outcome.mfaRequired) {
          await finishLogin(outcome.user);
        }
      } catch {
        setError('That code was not accepted. Try again.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (email.trim() === '' || password === '') {
      setError('Enter your email address and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      const outcome = await login({ email: email.trim(), password });
      if (outcome.mfaRequired) {
        setTicket(outcome.ticket);
      } else {
        await finishLogin(outcome.user);
      }
    } catch {
      setError('That email address and password did not match an account.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthLayout
      title={ticket === null ? 'Sign in' : 'Two-factor code'}
      subtitle={
        ticket === null
          ? 'Sign in to reach your workspaces.'
          : 'Enter the code from your authenticator app.'
      }
    >
      <AuthForm onSubmit={(event) => void handleSubmit(event)}>
        {ticket === null ? (
          <>
            <Field
              id="email"
              label="Email address"
              name="email"
              type="email"
              autoComplete="username webauthn"
              data-testid="login-email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={isSubmitting}
            />
            <Field
              id="password"
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              data-testid="login-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
            />
          </>
        ) : (
          <Field
            id="code"
            label="Authentication code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={isSubmitting}
          />
        )}

        <ErrorAlert message={error} />

        <AuthSubmitButton
          type="submit"
          disabled={isSubmitting}
          data-testid="login-submit"
        >
          {isSubmitting ? 'Signing in' : 'Sign in'}
        </AuthSubmitButton>
      </AuthForm>

      {ticket === null && (
        <>
          <div className="hidden space-y-4 has-[a]:block has-[button]:block">
            <div className="flex items-center gap-3 text-2xs text-text-faint">
              <span className="h-px flex-1 bg-line" />
              or
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="space-y-2">
              <PasskeySignInButton
                email={email}
                onResult={(result) => void handlePasskeyResult(result)}
                disabled={isSubmitting}
              />
              <OAuthProviderButtons
                returnTo={returnTo}
                disabled={isSubmitting}
              />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-text-muted">
              <TextLink to="/forgot-password">Forgot your password?</TextLink>
            </p>
            <AuthRedirectLink
              text="No account yet?"
              linkText="Create one"
              to="/register"
            />
          </div>
        </>
      )}
    </AuthLayout>
  );
};

export default Login;
