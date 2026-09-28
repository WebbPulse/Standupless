/**
 * Guards routes meant for signed-out users.
 */

import React, { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { identityOrigin } from '../../api/identityClient';
import { useAuth } from '../../hooks/useAuth';
import { authorizeReturn, wantsFreshLogin } from '../../lib/authorizeReturn';
import Spinner from '../ui/spinner';

/** Hands the browser back to the API's authorize endpoint, outside the router. */
const AuthorizeHandoff: React.FC<{ url: string }> = ({ url }) => {
  useEffect(() => {
    window.location.assign(url);
  }, [url]);
  return <Spinner />;
};

/**
 * Shows a spinner while the session has never settled, then bounces a signed in
 * user away, honouring a same-origin `returnTo`, or an MCP authorize URL on the
 * API origin unless the API asked for a fresh sign in with `prompt=login`. The
 * redirect also waits on `!isBusy` so a sign in already in flight keeps the page
 * mounted and holds its state, which is what carries an MFA challenge from the
 * first leg to the second.
 */
const GuestRoute: React.FC = () => {
  const { isAuthenticated, isLoading, isBusy } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <Spinner />;
  }

  if (isAuthenticated && !isBusy) {
    const params = new URLSearchParams(location.search);
    const returnTo = params.get('returnTo');
    const authorize = authorizeReturn(returnTo, identityOrigin());
    if (authorize !== null) {
      if (wantsFreshLogin(params)) return <Outlet />;
      return <AuthorizeHandoff url={authorize} />;
    }
    if (
      returnTo !== null &&
      returnTo.startsWith('/') &&
      !returnTo.startsWith('//')
    ) {
      return <Navigate to={returnTo} replace />;
    }
    return <Navigate to="/workspaces" state={{ from: location }} replace />;
  }

  return <Outlet />;
};

export default GuestRoute;
