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
 *
 * The column is the containing block for every absolutely positioned element
 * below it and clips them, so a visually hidden label or input at the foot of a
 * long page can never stretch the document past the viewport. The document
 * itself is locked while the column is mounted, through the `data-app-shell`
 * rule in the global stylesheet, so only the panes inside the shell scroll.
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
    <div
      data-app-shell=""
      data-testid="app-shell"
      className="relative flex h-dvh flex-col overflow-clip"
    >
      <DevelopmentBanner />
      <div
        data-testid="app-shell-body"
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <Outlet />
      </div>
    </div>
  );
};

export default ProtectedRoute;
