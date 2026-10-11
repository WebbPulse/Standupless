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
import { useNavigate } from 'react-router-dom';
import { browserTimezone } from '../api/home';
import { getIdentityClient } from '../api/identityClient';
import { updatePreferences } from '../api/notifications';
import { clearIssueContextCache } from '../lib/issueContextCache';
import { clearSignedIn, useSignedInHint } from '../lib/signedInHint';
import { setViewerTimezone } from '../lib/viewerTimezone';
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
    void updatePreferences({ timezone: browserTimezone() })
      .then((profile) => {
        if (user !== null && typeof profile.timezone === 'string') {
          setUser({ ...user, timezone: profile.timezone });
        }
      })
      .catch(() => undefined);
  }, [signedIn, stored, user, setUser]);
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
  useTimezoneCapture(isAuthenticated ? user : null, setUser);

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
    async (to: string = '/') => {
      try {
        await packageLogout();
      } catch {
        void 0;
      }
      clearIssueContextCache();
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
