/**
 * A marker that this browser holds a signed in session, read by the inline
 * script in the prerendered home page to send a returning person straight into
 * their last workspace before the landing page paints. It is never a token:
 * the workspace route still checks the session and sends a stale one to sign
 * in, which then clears the marker.
 */

import { useEffect } from 'react';

/** The storage key the signed in marker is held under. */
export const SIGNED_IN_HINT_STORAGE_KEY = 'standupless-signed-in';

/** The value the marker holds while a session is live. */
export const SIGNED_IN_HINT_VALUE = '1';

/** Whether this browser holds the signed in marker. */
export const hasSignedInHint = (): boolean => {
  try {
    return (
      globalThis.localStorage.getItem(SIGNED_IN_HINT_STORAGE_KEY) ===
      SIGNED_IN_HINT_VALUE
    );
  } catch {
    return false;
  }
};

/** Records that this browser holds a signed in session. */
export const markSignedIn = (): void => {
  try {
    globalThis.localStorage.setItem(
      SIGNED_IN_HINT_STORAGE_KEY,
      SIGNED_IN_HINT_VALUE
    );
  } catch {
    return;
  }
};

/** Drops the signed in marker. */
export const clearSignedIn = (): void => {
  try {
    globalThis.localStorage.removeItem(SIGNED_IN_HINT_STORAGE_KEY);
  } catch {
    return;
  }
};

/**
 * Keeps the marker in step with the session once it has settled: set while
 * signed in, dropped when signed out or when the session has lapsed.
 */
export const useSignedInHint = (
  isAuthenticated: boolean,
  isLoading: boolean
): void => {
  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) {
      markSignedIn();
    } else {
      clearSignedIn();
    }
  }, [isAuthenticated, isLoading]);
};
