/**
 * Guards routes that need a signed-in user.
 */

import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { usePinnedViewport } from '../../hooks/usePinnedViewport';
import { isNewIssuePath } from '../../lib/newIssueUrl';
import BootSplash from '../layout/BootSplash';

/**
 * Shows the cold start screen while the session has never settled, redirects to login when
 * no session is held, and renders the route otherwise. `isLoading` is true only
 * until the session first settles, so a token call made from inside the route
 * keeps the page mounted, and `isAuthenticated` stays true for the duration of
 * such a call, so neither branch fires mid-request.
 *
 * A signed in page renders in a column the height of the viewport, so the
 * workspace shell's panes fill it.
 *
 * The column is the containing block for every absolutely positioned element
 * below it and clips them, so a visually hidden label or input at the foot of a
 * long page can never stretch the document past the viewport. The document
 * itself is locked while the column is mounted, through the `data-app-shell`
 * rule in the global stylesheet, so only the panes inside the shell scroll.
 * That rule also drops the body's minimum height, so the document is exactly
 * as tall as the shell and has no room to scroll, and `usePinnedViewport`
 * returns the document to its origin if script or the on screen keyboard
 * moves it anyway, so the top bar is never left above the screen on a phone.
 *
 * A prefilled new issue link sends the visitor to sign in with the link in
 * `returnTo`, so they land back on the dialog with its fields set.
 */
const ProtectedRoute: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  usePinnedViewport();

  if (isLoading) {
    return <BootSplash />;
  }

  if (!isAuthenticated) {
    if (isNewIssuePath(location.pathname)) {
      const back = `${location.pathname}${location.search}`;
      return (
        <Navigate
          to={`/login?returnTo=${encodeURIComponent(back)}`}
          state={{ from: location }}
          replace
        />
      );
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    <div
      data-app-shell=""
      data-testid="app-shell"
      className="relative flex h-dvh flex-col overflow-clip"
    >
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
