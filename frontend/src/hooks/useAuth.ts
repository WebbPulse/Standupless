/**
 * Accessor for the session that fails loudly outside its provider. A thin
 * wrapper over `useAuth` from `@webbpulse/auth/react`, adding the `UserRead`
 * typing and a logout that returns to the home page.
 */

import { useContext } from 'react';
import { useAuth as usePackageAuth } from '@webbpulse/auth/react';
import {
  AuthExtrasContext,
  type AuthContextType,
} from '../contexts/AuthContextDefinition';
import type { UserRead } from '../types/Api';

/** Returns the current session, throwing outside an AuthProvider. */
export const useAuth = (): AuthContextType => {
  const extras = useContext(AuthExtrasContext);
  if (extras === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  const { isAuthenticated, isLoading, isBusy, user } =
    usePackageAuth<UserRead>();
  const { login, logout, checkAuthStatus } = extras;

  return {
    isAuthenticated,
    user,
    isLoading,
    isBusy,
    login,
    logout,
    checkAuthStatus,
  };
};
