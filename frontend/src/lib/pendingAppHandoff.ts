/**
 * Remembers, in the browser, which app asked to sign in. Sign-up, password reset
 * and email verification can leave the handoff page and come back through a
 * mailed link, which drops the `returnTo` query, so this is what still leads back
 * to the app. It holds only the page path with the app's public PKCE challenge,
 * never a code or a verifier, and a stale challenge just fails in the app, which
 * offers a retry.
 */

import { DESKTOP_HANDOFF_PATH } from './paths';

/** Where the path is kept in the browser. */
export const APP_HANDOFF_STORAGE_KEY = 'standupless.appHandoffReturn';

/** How long the way back is offered: long enough to read a mailed link. */
export const APP_HANDOFF_TTL_MS = 60 * 60 * 1000;

/** The request kept for the way back. */
interface PendingReturn {
  path: string;
  savedAt: number;
}

/** The browser storage, or null where none is usable. */
const browserStorage = (): Storage | null => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

/** Keeps the handoff page's path and query as the way back to the app. */
export const rememberAppHandoff = (
  path: string,
  now: number = Date.now(),
  storage: Storage | null = browserStorage()
): void => {
  const pending: PendingReturn = { path, savedAt: now };
  try {
    storage?.setItem(APP_HANDOFF_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    return;
  }
};

/** Forgets the way back, once the app has its sign-in or the person stayed. */
export const clearAppHandoff = (
  storage: Storage | null = browserStorage()
): void => {
  try {
    storage?.removeItem(APP_HANDOFF_STORAGE_KEY);
  } catch {
    return;
  }
};

/**
 * The handoff page to go back to, or null when none is kept, it is too old, or
 * the stored value is not a path on that page, since it becomes a link.
 */
export const pendingAppHandoffPath = (
  now: number = Date.now(),
  storage: Storage | null = browserStorage()
): string | null => {
  try {
    const raw = storage?.getItem(APP_HANDOFF_STORAGE_KEY) ?? null;
    if (raw === null) return null;
    const pending = JSON.parse(raw) as Partial<PendingReturn>;
    if (
      typeof pending.path !== 'string' ||
      typeof pending.savedAt !== 'number' ||
      !pending.path.startsWith(`${DESKTOP_HANDOFF_PATH}?`) ||
      now - pending.savedAt > APP_HANDOFF_TTL_MS
    ) {
      return null;
    }
    return pending.path;
  } catch {
    return null;
  }
};
