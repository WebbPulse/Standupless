/**
 * Spends a mailed email change link. Opened from the new mailbox, possibly in
 * another browser, so it needs no session. A POST spends the token rather than
 * the page load itself, so a mail scanner that fetches the link changes
 * nothing, and a ref keeps the StrictMode double mount from spending it twice.
 * Every other session ends once the address changes.
 */

import React, { useEffect, useRef, useState } from 'react';
import type { EmailChangeConfirmOutcome } from '@webbpulse/auth';
import { useSearchParams } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import AuthRedirectLink from '../../components/auth/AuthRedirectLink';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Spinner from '../../components/ui/spinner';
import { getIdentityClient } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';

/** The sentence for each refusal, used when the server sent none of its own. */
const REFUSAL_FALLBACKS: Record<string, string> = {
  'invalid-link':
    'This link is no longer valid. Email change links expire, can only be used once, and stop working when a newer one is sent.',
  taken: 'Another account now signs in with that address.',
  'rate-limited': 'Too many attempts. Wait a few minutes, then try again.',
  unavailable:
    'Email is not configured for this deployment, so the address cannot be changed.',
};

/** Where the page stands. */
type State =
  | { kind: 'confirming' }
  | { kind: 'confirmed' }
  | { kind: 'missing-token' }
  | { kind: 'refused'; message: string }
  | { kind: 'failed' };

/** The sentence a refused confirmation shows. */
const refusalMessage = (
  outcome: Exclude<EmailChangeConfirmOutcome, { ok: true }>
): string =>
  outcome.message === ''
    ? (REFUSAL_FALLBACKS[outcome.reason] ??
      'That email change link could not be used.')
    : outcome.message;

/** Reports the outcome of spending an email change link. */
const VerifyEmailChange: React.FC = () => {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { checkAuthStatus } = useAuth();
  const [state, setState] = useState<State>(
    token === '' ? { kind: 'missing-token' } : { kind: 'confirming' }
  );
  const spent = useRef(false);

  useEffect(() => {
    if (token === '' || spent.current) return;
    spent.current = true;
    const client = getIdentityClient();
    if (client === null) {
      setState({ kind: 'failed' });
      return;
    }
    client
      .confirmEmailChange({ token })
      .then((outcome) => {
        if (outcome.ok) {
          setState({ kind: 'confirmed' });
          void checkAuthStatus();
          return;
        }
        setState({ kind: 'refused', message: refusalMessage(outcome) });
      })
      .catch(() => {
        setState({ kind: 'failed' });
      });
  }, [token, checkAuthStatus]);

  return (
    <AuthLayout title="Confirm your new email">
      {state.kind === 'confirming' && <Spinner label="Confirming" />}
      {state.kind === 'confirmed' && (
        <ConfirmationAlert message="Your sign-in email is changed. Other devices were signed out." />
      )}
      {state.kind === 'missing-token' && (
        <ErrorAlert message="This link is missing its token. Request a new one from your account settings." />
      )}
      {state.kind === 'refused' && <ErrorAlert message={state.message} />}
      {state.kind === 'failed' && (
        <ErrorAlert message="Could not reach the server. Check your connection and open the link again." />
      )}
      {state.kind !== 'confirming' && (
        <AuthRedirectLink
          text="Go to"
          linkText="your workspaces"
          to="/workspaces"
        />
      )}
    </AuthLayout>
  );
};

export default VerifyEmailChange;
