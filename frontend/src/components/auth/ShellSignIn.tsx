/**
 * The one screen a signed out person sees inside the desktop and mobile apps.
 * Signing in, creating an account and resetting a password all happen in the
 * system browser, so the app holds no credential field and needs no provider or
 * passkey support of its own. A sign-in that did not finish comes back here with
 * its reason beside the retry.
 *
 * The reason is read from the query on every render rather than kept in state,
 * because a failed handoff navigates to this same route without remounting it.
 */

import React, { useEffect, useState } from 'react';
import { useAuthClient } from '@webbpulse/auth/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  describeDesktopHandoffFailure,
  desktopBridge,
} from '../../lib/desktop';
import {
  completeMobileBrowserSignIn,
  isMobileHandoffLink,
  isMobileSignInCancelled,
  watchMobileBrowserClosed,
} from '../../lib/mobileHandoff';
import { isMobileShell } from '../../lib/mobile';
import { DESKTOP_HANDOFF_FAILED_PARAM } from '../../lib/paths';
import AuthLayout from '../../pages/authentication/AuthLayout';
import AuthSubmitButton from '../../pages/authentication/AuthSubmitButton';
import AuthForm from './AuthForm';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';

/** Said when the browser closed before the sign-in finished. */
const CLOSED_MESSAGE =
  'The browser was closed before the sign-in finished. Try again.';

/** Said when a pasted value is not a sign-in link. */
const INVALID_LINK_MESSAGE = describeDesktopHandoffFailure('invalid-link');

/** Props for ShellSignIn: how this app opens the browser. */
export interface ShellSignInProps {
  /** Opens the browser, answering the callback when it returned one directly. */
  start: () => Promise<string | null>;
}

/** Sends a signed out person to the browser and waits for them to come back. */
const ShellSignIn: React.FC<ShellSignInProps> = ({ start }) => {
  const client = useAuthClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [started, setStarted] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [link, setLink] = useState('');

  const failure = describeDesktopHandoffFailure(
    searchParams.get(DESKTOP_HANDOFF_FAILED_PARAM)
  );
  const message = failure ?? localError;
  const waiting = started && message === null;
  const completeSignInLink = desktopBridge()?.completeSignInLink;

  useEffect(() => {
    if (!waiting || !isMobileShell()) return undefined;
    return watchMobileBrowserClosed(() => {
      setLocalError(CLOSED_MESSAGE);
    });
  }, [waiting]);

  /** Opens the browser, then finishes when it answered with the callback. */
  const openBrowser = async () => {
    setLocalError(null);
    setStarted(true);
    if (searchParams.has(DESKTOP_HANDOFF_FAILED_PARAM)) {
      const next = new URLSearchParams(searchParams);
      next.delete(DESKTOP_HANDOFF_FAILED_PARAM);
      setSearchParams(next, { replace: true });
    }
    try {
      const callback = await start();
      if (callback === null) return;
      const path = await completeMobileBrowserSignIn(callback, client);
      void navigate(path, { replace: true });
    } catch (reason) {
      setLocalError(
        isMobileSignInCancelled(reason)
          ? CLOSED_MESSAGE
          : describeDesktopHandoffFailure('browser-unavailable')
      );
    }
  };

  /** Hands a pasted link to the app, which holds what redeems it. */
  const submitLink = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const pasted = link.trim();
    if (!isMobileHandoffLink(pasted)) {
      setLocalError(INVALID_LINK_MESSAGE);
      return;
    }
    setLocalError(null);
    completeSignInLink?.(pasted);
  };

  return (
    <AuthLayout
      title={waiting ? 'Finish in your browser' : 'Sign in to Standupless'}
      subtitle={
        waiting
          ? 'Sign in on the page that opened, and this app will pick it up from there.'
          : 'You sign in, create an account or reset a password in your browser, then come back here.'
      }
    >
      <ErrorAlert message={message} />
      <AuthSubmitButton
        type="button"
        autoFocus
        onClick={() => void openBrowser()}
        data-testid="shell-sign-in-browser"
      >
        {waiting ? 'Open the browser again' : 'Continue in browser'}
      </AuthSubmitButton>
      {started && completeSignInLink !== undefined && (
        <AuthForm onSubmit={submitLink}>
          <Field
            id="sign-in-link"
            label="Or paste the sign-in link from your browser"
            name="sign-in-link"
            type="text"
            autoComplete="off"
            data-testid="shell-sign-in-link"
            value={link}
            onChange={(event) => setLink(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            className="w-full"
            data-testid="shell-sign-in-link-submit"
          >
            Finish signing in
          </Button>
        </AuthForm>
      )}
    </AuthLayout>
  );
};

export default ShellSignIn;
