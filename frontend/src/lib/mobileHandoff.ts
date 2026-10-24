/**
 * Signing in through the system browser from the iOS and Android apps, for the
 * providers and passkeys the app's web view cannot finish. The page makes a
 * PKCE pair, keeps the verifier on the device, and opens the handoff page that
 * the desktop app uses in an in-app browser tab with the challenge. The signed
 * in browser hands a single-use code back on `<scheme>://auth/handoff`, which
 * the app delivers to the page as an app URL, and the page redeems it with the
 * verifier. The code is never routed, so it never reaches history or the
 * address.
 *
 * The verifier lives in local storage rather than memory so a sign-in still
 * finishes when the operating system stopped the app while the browser was
 * open, and it is spent on first use or after ten minutes.
 */

import {
  createDesktopHandoffPkce,
  DESKTOP_HANDOFF_CALLBACK_HOST,
  desktopHandoffLaunchUrl,
  isHandoffSchemeAllowed,
  type AuthClient,
} from '@webbpulse/auth';
import { desktopHandoffSchemes } from '../config/app';
import { isMobileShell } from './mobile';
import { DESKTOP_HANDOFF_FAILED_PARAM, WORKSPACES_PATH } from './paths';

/** How long a browser sign-in may take before its verifier is discarded. */
export const MOBILE_HANDOFF_TTL_MS = 10 * 60 * 1000;

/** Where the pending verifier is kept on the device. */
export const MOBILE_HANDOFF_STORAGE_KEY = 'standupless.mobileHandoff';

/** The verifier of the one browser sign-in in flight. */
interface PendingHandoff {
  verifier: string;
  startedAt: number;
}

/** The storage the verifier is kept in, or null where none is usable. */
const deviceStorage = (): Storage | null => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

/**
 * The scheme this deployment hands sign-ins to, which is the one the app for
 * this environment registers, or null when the handoff is not configured.
 */
export const mobileHandoffScheme = (
  schemes: readonly string[] = desktopHandoffSchemes
): string | null => schemes[0] ?? null;

/** Keeps a verifier as the one pending sign-in, replacing any earlier one. */
export const storeMobileHandoffVerifier = (
  verifier: string,
  now: number = Date.now(),
  storage: Storage | null = deviceStorage()
): void => {
  const pending: PendingHandoff = { verifier, startedAt: now };
  try {
    storage?.setItem(MOBILE_HANDOFF_STORAGE_KEY, JSON.stringify(pending));
  } catch {
    return;
  }
};

/**
 * Takes the pending verifier, once, or null when none is pending, it expired,
 * or the stored value is unreadable.
 */
export const takeMobileHandoffVerifier = (
  now: number = Date.now(),
  storage: Storage | null = deviceStorage()
): string | null => {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(MOBILE_HANDOFF_STORAGE_KEY) ?? null;
    storage?.removeItem(MOBILE_HANDOFF_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const pending = JSON.parse(raw) as Partial<PendingHandoff>;
    if (
      typeof pending.verifier !== 'string' ||
      typeof pending.startedAt !== 'number'
    ) {
      return null;
    }
    return now - pending.startedAt <= MOBILE_HANDOFF_TTL_MS
      ? pending.verifier
      : null;
  } catch {
    return null;
  }
};

/**
 * Whether a browser sign-in is pending, without spending it. The launch URL
 * the app answers stays the same for the life of the process, so a reload
 * only redeems it while its verifier is still waiting.
 */
export const hasPendingMobileHandoff = (
  storage: Storage | null = deviceStorage()
): boolean => {
  try {
    return (storage?.getItem(MOBILE_HANDOFF_STORAGE_KEY) ?? null) !== null;
  } catch {
    return false;
  }
};

/**
 * Whether an app URL is a sign-in handoff callback, `<scheme>://auth/...` on an
 * allowed scheme, with or without a code.
 */
export const isMobileHandoffLink = (
  url: string,
  schemes: readonly string[] = desktopHandoffSchemes
): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.host === DESKTOP_HANDOFF_CALLBACK_HOST &&
    isHandoffSchemeAllowed(parsed.protocol.replace(/:$/, ''), schemes)
  );
};

/** The sign-in page path, saying why a handoff did not finish. */
export const mobileHandoffFailedPath = (reason: string): string => {
  const query = new URLSearchParams({ [DESKTOP_HANDOFF_FAILED_PARAM]: reason });
  return `/login?${query.toString()}`;
};

/**
 * Starts a browser sign-in: a fresh PKCE pair, its verifier kept on the
 * device, and the handoff page opened in an in-app browser tab.
 */
export const startMobileBrowserSignIn = async (
  scheme: string
): Promise<void> => {
  const pkce = await createDesktopHandoffPkce();
  const url = desktopHandoffLaunchUrl({
    origin: globalThis.location.origin,
    challenge: pkce.challenge,
    scheme,
    allowedSchemes: desktopHandoffSchemes,
  });
  storeMobileHandoffVerifier(pkce.verifier);
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url });
};

/**
 * The mobile app's browser sign-in, or null in a browser or on a deployment
 * that does not hand sign-ins to the apps.
 */
export const mobileBrowserSignIn = (): (() => Promise<void>) | null => {
  if (!isMobileShell()) return null;
  const scheme = mobileHandoffScheme();
  return scheme === null ? null : () => startMobileBrowserSignIn(scheme);
};

/**
 * Redeems a handoff callback and answers the path the page should go to: the
 * workspaces on success, or the sign-in page with the reason on failure. Any
 * failure spends the code, so the page tells the person to start again.
 */
export const completeMobileBrowserSignIn = async (
  url: string,
  client: Pick<AuthClient, 'completeDesktopHandoff'>,
  verifier: string | null = takeMobileHandoffVerifier()
): Promise<string> => {
  if (verifier === null) return mobileHandoffFailedPath('expired');
  try {
    const outcome = await client.completeDesktopHandoff({
      url,
      codeVerifier: verifier,
    });
    return outcome.ok
      ? WORKSPACES_PATH
      : mobileHandoffFailedPath(outcome.reason);
  } catch {
    return mobileHandoffFailedPath('failed');
  }
};
