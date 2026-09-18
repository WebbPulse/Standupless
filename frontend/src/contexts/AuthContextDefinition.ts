/**
 * Context object and type for the Standupless-only half of the session, kept
 * apart from the provider so the provider file exports only components and stays
 * refresh safe. Status, the user and the session calls live in
 * `@webbpulse/auth`; this context carries only what that package does not own.
 */

import { createContext } from 'react';
import type { UserRead } from '../types/Api';

/** The session calls Standupless adds on top of the package's `useAuth`. */
export interface AuthExtrasContextType {
  /** Seeds the user a login response already returned, with no extra request. */
  login: (userData: UserRead) => void;
  /**
   * Ends the session through the package store, then returns to the home page.
   * The navigation waits for the logout call to settle, because navigating first
   * aborts the in-flight request and leaves the refresh cookie alive.
   */
  logout: () => Promise<void>;
  /**
   * Re-reads the signed in profile without rotating the refresh cookie. A 401
   * ends the session, exactly as a failed refresh does.
   */
  checkAuthStatus: () => Promise<void>;
}

/**
 * The full value `useAuth` returns: the package store's status and user plus the
 * calls above.
 */
export interface AuthContextType extends AuthExtrasContextType {
  isAuthenticated: boolean;
  user: UserRead | null;
  /** True only until the session first settles. The flag a route guard gates on. */
  isLoading: boolean;
  /** True while a session call is in flight. The flag a button spinner gates on. */
  isBusy: boolean;
}

/** Context carrying the Standupless-only session calls to the tree. */
export const AuthExtrasContext = createContext<
  AuthExtrasContextType | undefined
>(undefined);
