/**
 * Signing in through the system browser from the iOS and Android apps, the only
 * way into either. The page makes a PKCE pair, keeps the verifier on the device,
 * and opens the handoff page that the desktop app uses with the challenge. iOS
 * opens it in an `ASWebAuthenticationSession`, which shares Safari's sign-ins and
 * answers with the callback directly. Android opens it in a Custom Tab, and the
 * app delivers the callback as an app URL. Either way the signed in browser hands
 * a single-use code back on `<scheme>://auth/handoff` and the page redeems it with
 * the verifier. The code is never routed, so it never reaches history or the
 * address.
 *
 * The verifier lives in local storage rather than memory so a sign-in still
 * finishes when the operating system stopped the app while the browser was
 * open, and it is spent on first use or after ten minutes.
 */

import {
  createDesktopHandoffPkce,
  createDesktopHandoffVerifierStore,
  desktopHandoffLaunchUrl,
  type AuthClient,
} from '@webbpulse/auth';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { desktopHandoffSchemes } from '../config/app';
import { isMobileShell } from './mobile';
import { DESKTOP_HANDOFF_FAILED_PARAM, WORKSPACES_PATH } from './paths';

/** Where the pending verifier is kept on the device. */
export const MOBILE_HANDOFF_STORAGE_KEY = 'standupless.mobileHandoff';

/** The verifier of the one browser sign-in in flight. */
export const mobileHandoffVerifier = createDesktopHandoffVerifierStore({
  storageKey: MOBILE_HANDOFF_STORAGE_KEY,
});

/**
 * The scheme this deployment hands sign-ins to, which is the one the app for
 * this environment registers, or null when the handoff is not configured.
 */
export const mobileHandoffScheme = (
  schemes: readonly string[] = desktopHandoffSchemes
): string | null => schemes[0] ?? null;

/** The sign-in page path, saying why a handoff did not finish. */
export const mobileHandoffFailedPath = (reason: string): string => {
  const query = new URLSearchParams({ [DESKTOP_HANDOFF_FAILED_PARAM]: reason });
  return `/login?${query.toString()}`;
};

/** The app's own iOS plugin around `ASWebAuthenticationSession`. */
interface WebAuthSessionPlugin {
  start: (options: {
    url: string;
    callbackScheme: string;
  }) => Promise<{ url?: string }>;
  close: () => Promise<void>;
}

let webAuthSessionPlugin: WebAuthSessionPlugin | null = null;

/** Registers the iOS session plugin once, on first use. */
const webAuthSession = (): WebAuthSessionPlugin => {
  webAuthSessionPlugin ??=
    registerPlugin<WebAuthSessionPlugin>('WebAuthSession');
  return webAuthSessionPlugin;
};

/** Whether a native plugin refused with this error code. */
const hasErrorCode = (failure: unknown, code: string): boolean =>
  (failure as { code?: unknown } | null)?.code === code;

/** Whether the person closed the iOS sign-in sheet before it finished. */
export const isMobileSignInCancelled = (failure: unknown): boolean =>
  hasErrorCode(failure, 'cancelled');

/** Opens the handoff page in the tab whose callback arrives as an app URL. */
const openInBrowserTab = async (url: string): Promise<null> => {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url });
  return null;
};

/**
 * Starts a browser sign-in: a fresh PKCE pair, its verifier kept on the device,
 * and the handoff page opened. Answers the callback when the iOS session returns
 * it, or null when it will arrive as an app URL instead, as on Android and on an
 * iOS build from before the session plugin, which web deploys still reach.
 */
export const startMobileBrowserSignIn = async (
  scheme: string
): Promise<string | null> => {
  const pkce = await createDesktopHandoffPkce();
  const url = desktopHandoffLaunchUrl({
    origin: globalThis.location.origin,
    challenge: pkce.challenge,
    scheme,
    allowedSchemes: desktopHandoffSchemes,
  });
  mobileHandoffVerifier.keep(pkce.verifier);
  if (Capacitor.getPlatform() !== 'ios') return openInBrowserTab(url);
  try {
    const session = await webAuthSession().start({
      url,
      callbackScheme: scheme,
    });
    return session.url ?? null;
  } catch (failure) {
    if (hasErrorCode(failure, 'UNIMPLEMENTED')) return openInBrowserTab(url);
    throw failure;
  }
};

/**
 * Closes an iOS sign-in sheet still open when a callback arrived some other way,
 * such as from a mailed link that opened in Safari.
 */
export const closeMobileAuthSession = async (): Promise<void> => {
  if (Capacitor.getPlatform() !== 'ios') return;
  await webAuthSession()
    .close()
    .catch(() => undefined);
};

/**
 * Tells the sign-in screen when the browser tab closes, so a tab closed early
 * shows a reason rather than waiting forever. Answers how to stop listening. The
 * iOS session reports this through its own refusal and never fires it.
 */
export const watchMobileBrowserClosed = (
  listener: () => void
): (() => void) => {
  let stopped = false;
  let remove: (() => void) | null = null;
  void import('@capacitor/browser')
    .then(({ Browser }) => Browser.addListener('browserFinished', listener))
    .then((handle) => {
      remove = () => {
        void handle.remove();
      };
      if (stopped) remove();
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    remove?.();
  };
};

/** Opens the browser, answering the callback when it returned one directly. */
type MobileBrowserSignIn = () => Promise<string | null>;

/**
 * The mobile app's browser sign-in, or null in a browser or on a deployment
 * that does not hand sign-ins to the apps.
 */
export const mobileBrowserSignIn = (): MobileBrowserSignIn | null => {
  if (!isMobileShell()) return null;
  const scheme = mobileHandoffScheme();
  return scheme === null ? null : () => startMobileBrowserSignIn(scheme);
};

/**
 * Redeems a handoff callback and answers the path the page should go to: the
 * workspaces on success, or the sign-in page with the reason on failure. Any
 * failure spends the code, so the sign-in screen offers a fresh attempt.
 */
export const completeMobileBrowserSignIn = async (
  url: string,
  client: Pick<AuthClient, 'completeDesktopHandoff'>,
  verifier: string | null = mobileHandoffVerifier.take()
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
