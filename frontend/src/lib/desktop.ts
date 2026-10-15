/**
 * The bridge the Standupless desktop app exposes to the page, and the few
 * questions the web app asks of it. In a browser there is no bridge, every
 * helper answers as the web, and nothing here changes how the site behaves.
 */

/** Where the desktop downloads live: the fixed `desktop-latest` release. */
export const DESKTOP_DOWNLOAD_URL =
  'https://github.com/WebbPulse/Standupless/releases/tag/desktop-latest';

/** A native notification the shell shows for an inbox row. */
export interface DesktopNotification {
  title: string;
  body: string;
  path: string;
}

/** What the desktop preload puts on `window.standuplessDesktop`. */
export interface DesktopBridge {
  platform: string;
  version: string;
  passkeys: boolean;
  setBadgeCount: (count: number) => void;
  notify: (payload: DesktopNotification) => void;
  setTheme: (theme: 'system' | 'light' | 'dark') => void;
  onNavigate: (listener: (path: string) => void) => () => void;
  /**
   * Opens the system browser to sign in there and hand the session back
   * through the app's URL scheme. Absent on builds that predate the handoff.
   */
  signInWithBrowser?: () => void;
}

/** The bridge when the page runs inside the desktop app, otherwise null. */
export const desktopBridge = (): DesktopBridge | null => {
  if (typeof window === 'undefined') return null;
  const bridge = (window as { standuplessDesktop?: DesktopBridge })
    .standuplessDesktop;
  return bridge !== undefined && typeof bridge.setBadgeCount === 'function'
    ? bridge
    : null;
};

/** Whether the page runs inside the desktop app. */
export const isDesktopShell = (): boolean => desktopBridge() !== null;

/**
 * Whether passkey sign in can work here. The desktop app on macOS and Linux has
 * no platform authenticator, so a ceremony there would hang with no prompt.
 */
export const desktopSupportsPasskeys = (): boolean =>
  desktopBridge()?.passkeys ?? true;

/**
 * The desktop app's browser sign-in, or null in a browser or on a desktop
 * build that predates the handoff.
 */
export const desktopBrowserSignIn = (): (() => void) | null => {
  const bridge = desktopBridge();
  return typeof bridge?.signInWithBrowser === 'function'
    ? () => bridge.signInWithBrowser?.()
    : null;
};

/**
 * What the sign-in page says when the desktop app could not finish a browser
 * handoff, by the reason the app put in the query. Any failure has already
 * spent the code, so every message sends the person back to the app.
 */
export const describeDesktopHandoffFailure = (
  reason: string | null
): string | null => {
  if (reason === null || reason === '') return null;
  if (reason === 'rate-limited') {
    return 'Too many sign-in attempts from the app. Wait a few minutes, then start again from the app.';
  }
  if (reason === 'refused') {
    return 'That account cannot sign in to the desktop app. Start again from the app with another account.';
  }
  return 'The browser sign-in could not be completed. Start again from the app.';
};
