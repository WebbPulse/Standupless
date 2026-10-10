/**
 * The sign in page: password, passkey and OAuth, with a second leg answered by
 * a TOTP code or a passkey.
 */

import React, { useState } from 'react';
import {
  describeOAuthCallbackError,
  PASSKEY_FACTOR,
  safeReturnPath,
  TOTP_FACTOR,
  type PasskeySignInOutcome,
} from '@webbpulse/auth';
import {
  useAuth as usePackageAuth,
  useOAuthCallback,
} from '@webbpulse/auth/react';
import { LuKeyRound } from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import AuthSubmitButton from './AuthSubmitButton';
import AuthForm from '../../components/auth/AuthForm';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { identityOrigin } from '../../api/identityClient';
import OAuthProviderButtons from '../../components/auth/OAuthProviderButtons';
import PasskeySignInButton from '../../components/auth/PasskeySignInButton';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import Field from '../../components/ui/field';
import TextLink from '../../components/ui/link';
import { useAuth } from '../../hooks/useAuth';
import { authorizeReturn, loginReturnFor } from '../../lib/authorizeReturn';
import { describePasskeyMfaFailure } from '../../lib/passkeyMfa';
import type { UserRead } from '../../types/Api';

/** What the second leg asks for, given the answers it offers. */
const secondLegSubtitle = (code: boolean, passkey: boolean): string => {
  if (!code) return 'Confirm it is you with your passkey.';
  if (passkey) {
    return 'Enter the code from your authenticator app, or use a passkey.';
  }
  return 'Enter the code from your authenticator app.';
};

/** Signs a user in with a password, a passkey or a provider. */
const Login: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [factors, setFactors] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const authorizeTarget = authorizeReturn(
    searchParams.get('returnTo'),
    identityOrigin()
  );
  const returnTo = safeReturnPath(searchParams.get('returnTo'), '/workspaces');
  const { login: seedUser, checkAuthStatus } = useAuth();
  const { login, completeTotp, completeMfaWithPasskey } =
    usePackageAuth<UserRead>();

  /**
   * Moves to the second leg. `null` factors mean the challenge did not list
   * them, as on a provider callback, so both answers are offered.
   */
  const startSecondFactor = (next: string, listed: string[] | null) => {
    setTicket(next);
    setFactors(listed);
    setCode('');
  };

  const offersCode = factors === null || factors.includes(TOTP_FACTOR);
  const offersPasskey = factors === null || factors.includes(PASSKEY_FACTOR);

  /**
   * Finishes a sign in that already succeeded on the server, fetching the user
   * the token does not carry when the outcome did not embed one, then returns
   * to an MCP authorize URL when the API sent the browser here for one.
   */
  const finishLogin = async (user: UserRead | null) => {
    if (user !== null) {
      seedUser(user);
    } else {
      await checkAuthStatus();
    }
    if (authorizeTarget !== null) {
      window.location.assign(authorizeTarget);
      return;
    }
    void navigate(returnTo);
  };

  useOAuthCallback(async (result) => {
    if (result.kind === 'signed-in' || result.kind === 'linked') {
      await finishLogin(null);
      return;
    }
    if (result.kind === 'mfa-required') {
      startSecondFactor(result.ticket, null);
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
      startSecondFactor(result.ticket, result.factors);
      setError(null);
      return;
    }
    await finishLogin((result.user as UserRead | null) ?? null);
  };

  /** Answers the second leg with a passkey, or shows why it did not. */
  const handlePasskeyFactor = async () => {
    if (ticket === null) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const outcome = await completeMfaWithPasskey({ ticket });
      if (outcome.ok) {
        await finishLogin((outcome.user as UserRead | null) ?? null);
        return;
      }
      setError(describePasskeyMfaFailure(outcome, offersCode));
      if (outcome.reason === 'ticket-invalid') {
        setTicket(null);
        setFactors(null);
      }
    } finally {
      setIsSubmitting(false);
    }
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
        startSecondFactor(outcome.ticket, outcome.factors);
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
      title={ticket === null ? 'Sign in' : 'Two-factor authentication'}
      subtitle={
        ticket === null
          ? 'Sign in to reach your workspaces.'
          : secondLegSubtitle(offersCode, offersPasskey)
      }
    >
      {ticket !== null && !offersCode ? (
        <div className="space-y-4">
          <ErrorAlert message={error} />
          <AuthSubmitButton
            type="button"
            autoFocus
            onClick={() => void handlePasskeyFactor()}
            disabled={isSubmitting}
            data-testid="login-mfa-passkey"
          >
            {isSubmitting ? 'Waiting for your passkey' : 'Use a passkey'}
          </AuthSubmitButton>
        </div>
      ) : (
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
              autoFocus
              data-testid="login-code"
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

          {ticket !== null && offersPasskey && (
            <>
              <div className="flex items-center gap-3 text-2xs text-text-faint">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <Button
                variant="secondary"
                className="w-full"
                onClick={() => void handlePasskeyFactor()}
                disabled={isSubmitting}
                data-testid="login-mfa-passkey"
              >
                <LuKeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Use a passkey</span>
              </Button>
            </>
          )}
        </AuthForm>
      )}

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
                returnTo={
                  authorizeTarget === null
                    ? returnTo
                    : loginReturnFor(authorizeTarget)
                }
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
