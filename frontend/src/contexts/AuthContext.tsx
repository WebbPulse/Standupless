/**
 * Mounts the `@webbpulse/auth` provider and layers the Standupless-only session
 * calls on top of it.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  AuthProvider as PackageAuthProvider,
  useAuth as usePackageAuth,
  type AnyAuthClient,
} from '@webbpulse/auth/react';
import { clearPolledQueryCache } from '@webbpulse/api-client/react';
import { useNavigate } from 'react-router-dom';
import { getIdentityClient } from '../api/identityClient';
import { clearIssueContextCache } from '../lib/issueContextCache';
import { preferencesOf, setPreferences } from '../lib/preferences';
import { isAppShell, SHELL_SIGN_IN_PATH } from '../lib/shell';
import { clearSignedIn, useSignedInHint } from '../lib/signedInHint';
import { browserTimezone, setViewerTimezone } from '../lib/viewerTimezone';
import type { UserRead } from '../types/Api';
import {
  AuthExtrasContext,
  type AuthExtrasContextType,
} from './AuthContextDefinition';

/**
 * Keeps the viewer's due date zone in step with the profile, and stores the
 * browser's zone once on a profile that has none, so due date reminders land on
 * the day the person sees. A failed capture is left for the next session.
 */
const useTimezoneCapture = (
  user: UserRead | null,
  setUser: (user: UserRead) => void
): void => {
  const captured = useRef(false);
  const stored = user?.timezone;
  const signedIn = user !== null;

  useEffect(() => {
    setViewerTimezone(stored);
  }, [stored]);

  useEffect(() => {
    if (!signedIn || stored !== null || captured.current) {
      return;
    }
    captured.current = true;
    void import('../api/notifications')
      .then(({ updatePreferences }) =>
        updatePreferences({ timezone: browserTimezone() })
      )
      .then((profile) => {
        if (user !== null && typeof profile.timezone === 'string') {
          setUser({ ...user, timezone: profile.timezone });
        }
      })
      .catch(() => undefined);
  }, [signedIn, stored, user, setUser]);
};

/**
 * Copies the profile's interface and workflow preferences into the shared
 * store whenever they change, so a name, a date shortcut, the text size or
 * what copying a branch does follows the account rather than the browser. A signed out page keeps what was last in force.
 */
const usePreferenceSync = (user: UserRead | null): void => {
  const homeView = user?.home_view;
  const weekStart = user?.week_start;
  const nameDisplay = user?.name_display;
  const fontSize = user?.font_size;
  const autoAssign = user?.auto_assign_to_self;
  const branchStarts = user?.branch_copy_starts;
  const branchAssigns = user?.branch_copy_assigns;
  const signedIn = user !== null;

  useEffect(() => {
    if (!signedIn) return;
    setPreferences(
      preferencesOf({
        home_view: homeView,
        week_start: weekStart,
        name_display: nameDisplay,
        font_size: fontSize,
        auto_assign_to_self: autoAssign,
        branch_copy_starts: branchStarts,
        branch_copy_assigns: branchAssigns,
      })
    );
  }, [
    signedIn,
    homeView,
    weekStart,
    nameDisplay,
    fontSize,
    autoAssign,
    branchStarts,
    branchAssigns,
  ]);
};

/**
 * Empties the shared polled query cache once a signed in session ends, however
 * it ended: a sign out here, one in another tab, or an expired session. Several
 * cached keys, such as a team's statuses or the current user, carry no user,
 * so the next person signing in on this browser must not paint from them.
 */
const useSignedOutCacheClear = (
  isAuthenticated: boolean,
  isLoading: boolean
): void => {
  const signedIn = useRef(false);

  useEffect(() => {
    if (isAuthenticated) {
      signedIn.current = true;
      return;
    }
    if (!isLoading && signedIn.current) {
      signedIn.current = false;
      clearPolledQueryCache();
    }
  }, [isAuthenticated, isLoading]);
};

/**
 * Supplies the session calls `@webbpulse/auth` does not own. Mounted inside the
 * package provider so `useAuth` resolves, and holding no user of its own: the
 * package store is the single source of truth.
 */
const AuthExtrasProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const navigate = useNavigate();
  const {
    setUser,
    reloadUser,
    logout: packageLogout,
    isAuthenticated,
    isLoading,
    user,
  } = usePackageAuth<UserRead>();

  useSignedInHint(isAuthenticated, isLoading);
  useSignedOutCacheClear(isAuthenticated, isLoading);
  useTimezoneCapture(isAuthenticated ? user : null, setUser);
  usePreferenceSync(isAuthenticated ? user : null);

  const login = useCallback(
    (userData: UserRead) => {
      setUser(userData);
    },
    [setUser]
  );

  const checkAuthStatus = useCallback(async () => {
    try {
      await reloadUser();
    } catch {
      void 0;
    }
  }, [reloadUser]);

  const logout = useCallback(
    async (to: string = isAppShell() ? SHELL_SIGN_IN_PATH : '/') => {
      try {
        await packageLogout();
      } catch {
        void 0;
      }
      clearIssueContextCache();
      clearPolledQueryCache();
      clearSignedIn();
      void navigate(to, { replace: true });
    },
    [navigate, packageLogout]
  );

  const value = useMemo<AuthExtrasContextType>(
    () => ({ login, logout, checkAuthStatus }),
    [login, logout, checkAuthStatus]
  );

  return (
    <AuthExtrasContext.Provider value={value}>
      {children}
    </AuthExtrasContext.Provider>
  );
};

/**
 * Mounts the package provider, which spends the refresh cookie on mount, and
 * renders children bare when the identity client could not be built, so a
 * deployment with no identity origin still paints.
 */
export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const client = getIdentityClient();

  if (client === null) {
    return <>{children}</>;
  }

  return (
    <PackageAuthProvider client={client as unknown as AnyAuthClient}>
      <AuthExtrasProvider>{children}</AuthExtrasProvider>
    </PackageAuthProvider>
  );
};
