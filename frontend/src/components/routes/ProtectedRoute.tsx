/**
 * Guards routes that need a signed-in user.
 */

import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import DevelopmentBanner from '../layout/DevelopmentBanner';
import Spinner from '../ui/spinner';

/**
 * Shows a spinner while the session has never settled, redirects to login when
 * no session is held, and renders the route otherwise. `isLoading` is true only
 * until the session first settles, so a token call made from inside the route
 * keeps the page mounted, and `isAuthenticated` stays true for the duration of
 * such a call, so neither branch fires mid-request.
 *
 * A signed in page renders under the development notice, in a column the
 * height of the viewport, so the workspace shell's panes fill what the notice
 * leaves and the notice never scrolls away.
 */
const ProtectedRoute: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <Spinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div className="flex h-dvh flex-col">
      <DevelopmentBanner />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
};

export default ProtectedRoute;
