/**
 * The routes that keep the installable apps off the public site. Inside the
 * desktop or mobile app, `/` starts on sign in or the workspace, and a public
 * page opens in the system browser while the app stays where it was. In a
 * browser both render the web page unchanged.
 */

import React, { useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { RESUME_STATE } from '../../lib/lastWorkspace';
import { WORKSPACES_PATH } from '../../lib/paths';
import {
  isAppShell,
  openInSystemBrowser,
  SHELL_SIGN_IN_PATH,
} from '../../lib/shell';
import BootSplash from '../layout/BootSplash';

/**
 * Where an app starts: the cold start screen until the session settles, then
 * the last workspace for someone signed in, or sign in for everyone else.
 */
export const ShellStart: React.FC = () => {
  const { isAuthenticated, isLoading, isBusy } = useAuth();

  if (isLoading || isBusy) {
    return <BootSplash />;
  }
  if (isAuthenticated) {
    return <Navigate to={WORKSPACES_PATH} state={RESUME_STATE} replace />;
  }
  return <Navigate to={SHELL_SIGN_IN_PATH} replace />;
};

/**
 * Hands the public page just navigated to over to the system browser, once,
 * then steps back to the page the app came from, or to the app's start when
 * the public page was the first one loaded.
 */
const ShellPublicHandoff: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const handed = useRef(false);

  useEffect(() => {
    if (handed.current) return;
    handed.current = true;
    openInSystemBrowser(
      `${location.pathname}${location.search}${location.hash}`
    );
    if (location.key === 'default') {
      void navigate('/', { replace: true });
    } else {
      void navigate(-1);
    }
  }, [location, navigate]);

  return <BootSplash />;
};

/**
 * The layout route for the public site's pages, which apps never show. The
 * handoff is keyed by history entry, so each public page reached hands off.
 */
export const ShellPublicRoute: React.FC = () => {
  const location = useLocation();
  return isAppShell() ? (
    <ShellPublicHandoff key={location.key} />
  ) : (
    <Outlet />
  );
};
