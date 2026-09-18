/**
 * Mounts the `@webbpulse/auth` provider and layers the Standupless-only session
 * calls on top of it.
 */

import React, { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  AuthProvider as PackageAuthProvider,
  useAuth as usePackageAuth,
  type AnyAuthClient,
} from '@webbpulse/auth/react';
import { useNavigate } from 'react-router-dom';
import { getIdentityClient } from '../api/identityClient';
import type { UserRead } from '../types/Api';
import {
  AuthExtrasContext,
  type AuthExtrasContextType,
} from './AuthContextDefinition';

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
  } = usePackageAuth<UserRead>();

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

  const logout = useCallback(async () => {
    try {
      await packageLogout();
    } catch {
      void 0;
    }
    void navigate('/');
  }, [navigate, packageLogout]);

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
