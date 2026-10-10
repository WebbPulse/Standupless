/**
 * The bridge the Standupless desktop app exposes to the page, and the few
 * questions the web app asks of it. In a browser there is no bridge, every
 * helper answers as the web, and nothing here changes how the site behaves.
 */

/** Where the desktop downloads live: the newest GitHub release. */
export const DESKTOP_DOWNLOAD_URL =
  'https://github.com/WebbPulse/Standupless/releases/latest';

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
