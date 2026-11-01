/**
 * The page the desktop and mobile apps open in the system browser to sign in. A
 * signed out visitor is sent to sign in first and brought back with the app's
 * request intact. A signed in visitor sees which account the app would get and
 * either continues as it or switches, so an app never silently inherits the
 * wrong account. Only that click mints a single-use code and hands it to the app
 * through its own URL scheme. Nothing is minted on load, so a link someone else
 * crafted cannot sign the visitor into another device without a click.
 *
 * The request is remembered too, because a mailed link for a sign-up or password
 * reset comes back without it. A desktop browser can refuse the scheme, so there
 * the link can also be copied and pasted into the app. It is useless elsewhere,
 * since redeeming it takes the verifier the app holds.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { readDesktopHandoffRequest } from '@webbpulse/auth';
import { useAuthClient } from '@webbpulse/auth/react';
import { Navigate, useLocation } from 'react-router-dom';
import AuthLayout from '../authentication/AuthLayout';
import AuthSubmitButton from '../authentication/AuthSubmitButton';
import BootSplash from '../../components/layout/BootSplash';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import TextLink from '../../components/ui/link';
import { desktopHandoffSchemes } from '../../config/app';
import { useAuth } from '../../hooks/useAuth';
import { useCopy } from '../../hooks/useCopy';
import { currentDesktopPlatform } from '../../lib/desktop';
import { WORKSPACES_PATH } from '../../lib/paths';
import {
  clearAppHandoff,
  rememberAppHandoff,
} from '../../lib/pendingAppHandoff';

/** The sign-in page, returning here with the app's request kept in the query. */
const loginReturningTo = (pathAndQuery: string): string =>
  `/login?returnTo=${encodeURIComponent(pathAndQuery)}`;

/** Confirms, mints and hands a sign-in to the desktop or mobile app. */
const DesktopHandoff: React.FC = () => {
  const { isAuthenticated, isLoading, user, logout } = useAuth();
  const client = useAuthClient();
  const location = useLocation();
  const { copied, copy } = useCopy();
  const [minting, setMinting] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const path = `${location.pathname}${location.search}`;
  const request = useMemo(
    () => readDesktopHandoffRequest(path, desktopHandoffSchemes),
    [path]
  );
  const validRequest = request !== null;

  useEffect(() => {
    if (validRequest) rememberAppHandoff(path);
  }, [validRequest, path]);

  if (isLoading) {
    return <BootSplash />;
  }

  if (desktopHandoffSchemes.length === 0) {
    return (
      <AuthLayout
        title="App sign-in is not available"
        subtitle="This deployment does not hand sign-ins to the Standupless app. Sign in from the app instead."
      >
        <p className="text-sm text-text-muted">You can close this tab.</p>
      </AuthLayout>
    );
  }

  if (request === null) {
    return (
      <AuthLayout
        title="This link has expired"
        subtitle="The sign-in link from the Standupless app is incomplete or was not made by Standupless. Start again from the app."
      >
        <p className="text-sm text-text-muted">You can close this tab.</p>
      </AuthLayout>
    );
  }

  if (callbackUrl !== null) {
    return (
      <AuthLayout
        title="You can close this tab"
        subtitle="The Standupless app should now open and finish signing in."
      >
        <AuthSubmitButton
          type="button"
          onClick={() => window.location.assign(callbackUrl)}
          data-testid="desktop-handoff-open-again"
        >
          Open Standupless again
        </AuthSubmitButton>
        {currentDesktopPlatform() !== null && (
          <>
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => copy(callbackUrl)}
              data-testid="desktop-handoff-copy"
            >
              {copied ? 'Copied' : 'Copy sign-in link'}
            </Button>
            <p className="text-sm text-text-muted">
              If the app did not open, paste this link into its sign-in screen.
            </p>
          </>
        )}
      </AuthLayout>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to={loginReturningTo(path)} replace />;
  }

  /** Mints the code for the app's challenge and opens the app with it. */
  const handOff = async () => {
    setError(null);
    setMinting(true);
    const outcome = await client.handOffToDesktop({ url: path });
    setMinting(false);
    if (!outcome.ok) {
      setError(
        outcome.reason === 'not-authenticated'
          ? 'Your session ended. Sign in again, then start again from the app.'
          : outcome.message
      );
      return;
    }
    clearAppHandoff();
    setCallbackUrl(outcome.callbackUrl);
    window.location.assign(outcome.callbackUrl);
  };

  const email = user?.email;
  const hasEmail = email !== undefined && email !== '';

  return (
    <AuthLayout
      title="Sign in to the Standupless app"
      subtitle="The Standupless app asked to sign in with this browser."
    >
      <p className="text-sm text-text-muted">
        Only continue if you started this from the Standupless app on this
        device.
      </p>
      <ErrorAlert message={error} />
      <AuthSubmitButton
        type="button"
        autoFocus
        onClick={() => void handOff()}
        disabled={minting}
        data-testid="desktop-handoff-confirm"
      >
        <span className="truncate">
          {minting
            ? 'Opening Standupless'
            : hasEmail
              ? `Continue as ${email}`
              : 'Continue to the app'}
        </span>
      </AuthSubmitButton>
      <Button
        variant="secondary"
        className="w-full"
        onClick={() => void logout(loginReturningTo(path))}
        disabled={minting}
        data-testid="desktop-handoff-switch"
      >
        Use another account
      </Button>
      <p className="text-sm text-text-muted">
        <TextLink
          to={WORKSPACES_PATH}
          onClick={() => clearAppHandoff()}
          data-testid="desktop-handoff-stay"
        >
          Stay in the browser
        </TextLink>
      </p>
    </AuthLayout>
  );
};

export default DesktopHandoff;
