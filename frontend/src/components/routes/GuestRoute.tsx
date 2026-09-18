/**
 * Guards routes meant for signed-out users.
 */

import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import Spinner from '../ui/spinner';

/**
 * Shows a spinner while the session has never settled, then bounces a signed in
 * user away, honouring a same-origin `returnTo`. The redirect also waits on
 * `!isBusy` so a sign in already in flight keeps the page mounted and holds its
 * state, which is what carries an MFA challenge from the first leg to the second.
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
