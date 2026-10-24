/**
 * The page the desktop and mobile apps open in the system browser when their
 * own window cannot finish a sign-in. A signed out visitor is sent to sign in first and
 * brought back with the app's request intact. A signed in visitor sees what
 * will happen and confirms it, and only then is a single-use code minted and
 * handed to the app through its own URL scheme. Nothing is minted on load, so
 * a link someone else crafted cannot sign the visitor into another device
 * without a click.
 */

import React, { useMemo, useState } from 'react';
import { readDesktopHandoffRequest } from '@webbpulse/auth';
import { useAuthClient } from '@webbpulse/auth/react';
import { Navigate, useLocation } from 'react-router-dom';
import AuthLayout from '../authentication/AuthLayout';
import AuthSubmitButton from '../authentication/AuthSubmitButton';
import BootSplash from '../../components/layout/BootSplash';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import TextLink from '../../components/ui/link';
import { desktopHandoffSchemes } from '../../config/app';
import { useAuth } from '../../hooks/useAuth';
import { WORKSPACES_PATH } from '../../lib/paths';

/** Where the visitor is in the handoff. */
type Phase = 'ready' | 'minting' | 'opened';

/** The sign-in page, returning here with the app's request kept in the query. */
const loginReturningTo = (pathAndQuery: string): string =>
  `/login?returnTo=${encodeURIComponent(pathAndQuery)}`;

/** Confirms, mints and hands a sign-in to the desktop or mobile app. */
const DesktopHandoff: React.FC = () => {
  const { isAuthenticated, isLoading, user } = useAuth();
  const client = useAuthClient();
  const location = useLocation();
  const [phase, setPhase] = useState<Phase>('ready');
  const [error, setError] = useState<string | null>(null);

  const request = useMemo(
    () =>
      readDesktopHandoffRequest(
        `${location.pathname}${location.search}`,
        desktopHandoffSchemes
      ),
    [location.pathname, location.search]
  );

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

  if (!isAuthenticated) {
    return (
      <Navigate
        to={loginReturningTo(`${location.pathname}${location.search}`)}
        replace
      />
    );
  }

  /** Mints the code for the app's challenge and opens the app with it. */
  const handOff = async () => {
    setError(null);
    setPhase('minting');
    const outcome = await client.handOffToDesktop({
      url: `${location.pathname}${location.search}`,
    });
    if (!outcome.ok) {
      setPhase('ready');
      setError(
        outcome.reason === 'not-authenticated'
          ? 'Your session ended. Sign in again, then start again from the app.'
          : outcome.message
      );
      return;
    }
    setPhase('opened');
    window.location.assign(outcome.callbackUrl);
  };

  const email = user?.email;

  return (
    <AuthLayout
      title="Open the Standupless app?"
      subtitle={
        email === undefined || email === ''
          ? 'The Standupless app asked to sign in with this browser.'
          : `The Standupless app asked to sign in as ${email}.`
      }
    >
      <p className="text-sm text-text-muted">
        Only continue if you started this from the Standupless app on this
        device.
      </p>
      <ErrorAlert message={error} />
      <ConfirmationAlert
        message={
          phase === 'opened'
            ? 'The app should now open and finish signing in. You can close this tab.'
            : null
        }
      />
      <AuthSubmitButton
        type="button"
        autoFocus
        onClick={() => void handOff()}
        disabled={phase === 'minting'}
        data-testid="desktop-handoff-confirm"
      >
        {phase === 'minting'
          ? 'Opening Standupless'
          : phase === 'opened'
            ? 'Open Standupless again'
            : 'Open the Standupless app'}
      </AuthSubmitButton>
      <p className="text-sm text-text-muted">
        <TextLink to={WORKSPACES_PATH}>Stay in the browser</TextLink>
      </p>
    </AuthLayout>
  );
};

export default DesktopHandoff;
