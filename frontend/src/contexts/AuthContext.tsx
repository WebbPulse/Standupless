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
import { preferencesOf, setPreferences } from '../lib/preferences';
import { clearQueryPersistence } from '../lib/queryPersistence';
import { isAppShell, SHELL_SIGN_IN_PATH } from '../lib/shell';
import { clearSignedIn, useSignedInHint } from '../lib/signedInHint';
import {
  adoptTheme,
  readStoredTheme,
  setThemeSaver,
  type Theme,
} from '../lib/theme';
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
 * Keeps the theme on the account. The account's theme wins and is cached in
 * this browser for the pre-paint script; a profile with none takes this
 * browser's explicit choice once. While signed in, a theme chosen anywhere is
 * saved to the account, and only the latest save's answer is kept.
 */
const useThemeSync = (
  user: UserRead | null,
  setUser: (user: UserRead) => void
): void => {
  const uploaded = useRef(false);
  const latest = useRef(0);
  const current = useRef(user);
  const stored = user?.theme;
  const signedIn = user !== null;

  useEffect(() => {
    current.current = user;
  }, [user]);

  const save = useCallback(
    (theme: Theme) => {
      const ticket = latest.current + 1;
      latest.current = ticket;
      void import('../api/notifications')
        .then(({ updatePreferences }) => updatePreferences({ theme }))
        .then((profile) => {
          const held = current.current;
          if (ticket === latest.current && held !== null) {
            setUser({ ...held, theme: profile.theme ?? null });
          }
        })
        .catch(() => undefined);
    },
    [setUser]
  );

  useEffect(() => {
    if (!signedIn) return;
    setThemeSaver(save);
    return () => {
      setThemeSaver(null);
    };
  }, [signedIn, save]);

  useEffect(() => {
    if (!signedIn) return;
    if (stored !== null && stored !== undefined) {
      adoptTheme(stored);
      return;
    }
    const local = readStoredTheme();
    if (local === null || uploaded.current) return;
    uploaded.current = true;
    save(local);
  }, [signedIn, stored, save]);
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
  const pointerCursors = user?.pointer_cursors;
  const underlineLinks = user?.underline_links;
  const codeTheme = user?.code_theme;
  const convertEmoticons = user?.convert_emoticons;
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
        pointer_cursors: pointerCursors,
        underline_links: underlineLinks,
        code_theme: codeTheme,
        convert_emoticons: convertEmoticons,
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
    pointerCursors,
    underlineLinks,
    codeTheme,
    convertEmoticons,
    autoAssign,
    branchStarts,
    branchAssigns,
  ]);
};

/**
 * Empties the shared polled query cache once a signed in session ends, however
 * it ended: a sign out here, one in another tab, or an expired session. Several
 * cached keys, such as a team's statuses or the current user, carry no user,
 * so the next person signing in on this browser must not paint from them. The
 * device copy of the workspace's reads is deleted with it.
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
      void clearQueryPersistence();
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
  useThemeSync(isAuthenticated ? user : null, setUser);

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
      void clearQueryPersistence();
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
