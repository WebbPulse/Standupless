/**
 * Finishes a single sign-on wherever the identity service returns the
 * browser. The flags are read once, on the first render, because the guest
 * guard may redirect away from the landing URL before the session settles.
 *
 * A finished sign-in joins the workspace that owns the connection and moves
 * into it from a page that only lists workspaces. A refusal raises a toast,
 * except on the sign-in page, which shows it beside the form. A settings test
 * sign-in leaves its flags for the settings section to read.
 */

import React, { useContext, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AuthExtrasContext } from '../../contexts/AuthContextDefinition';
import { useAuth } from '../../hooks/useAuth';
import {
  describeSsoError,
  landAfterSso,
  SSO_ERROR_PARAM,
  SSO_PARAM,
  SSO_TEST_PARAM,
} from '../../lib/sso';
import { showErrorToast } from '../../lib/toast';

/** The flags a single sign-on return carried on the first render. */
interface SsoLanding {
  finished: boolean;
  error: string | null;
  test: boolean;
}

/** Reads the single sign-on flags off the address the app opened on. */
const readLanding = (): SsoLanding | null => {
  const params = new URLSearchParams(window.location.search);
  const finished = params.get(SSO_PARAM) === '1';
  const error = params.get(SSO_ERROR_PARAM);
  if (!finished && error === null) return null;
  return { finished, error, test: params.has(SSO_TEST_PARAM) };
};

/** The search string without the given parameters, with its `?` when any remain. */
const withoutParams = (search: string, names: string[]): string => {
  const params = new URLSearchParams(search);
  for (const name of names) params.delete(name);
  const rest = params.toString();
  return rest === '' ? '' : `?${rest}`;
};

/** Acts on the flags once the session has settled. */
const SsoReturnListener: React.FC = () => {
  const [landing] = useState(readLanding);
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const path = useRef(location.pathname);
  path.current = location.pathname;
  const handled = useRef(false);

  useEffect(() => {
    if (landing === null || handled.current || isLoading) return;
    handled.current = true;
    const params = new URLSearchParams(location.search);
    const strip: string[] = [];
    if (landing.error !== null) {
      strip.push(SSO_ERROR_PARAM);
      if (landing.test) strip.push(SSO_PARAM, SSO_TEST_PARAM);
      const message = describeSsoError(landing.error);
      if (message !== null && location.pathname !== '/login') {
        showErrorToast(message);
      }
    } else if (!landing.test) {
      strip.push(SSO_PARAM);
    }
    const leaving = location.pathname === '/login' && isAuthenticated;
    if (!leaving && strip.some((name) => params.has(name))) {
      void navigate(
        {
          pathname: location.pathname,
          search: withoutParams(location.search, strip),
          hash: location.hash,
        },
        { replace: true }
      );
    }
    if (landing.finished && landing.error === null && isAuthenticated) {
      void landAfterSso(
        (to) => {
          void navigate(to, { replace: true });
        },
        () => path.current
      );
    }
  }, [landing, isLoading, isAuthenticated, location, navigate]);

  return null;
};

/**
 * Mounts the listener only inside a working auth provider, which a deployment
 * without an identity origin does not have.
 */
export const SsoReturnHandler: React.FC = () => {
  const extras = useContext(AuthExtrasContext);
  if (extras === undefined) return null;
  return <SsoReturnListener />;
};

export default SsoReturnHandler;
