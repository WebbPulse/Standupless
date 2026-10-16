/**
 * What the web app does differently inside the installable apps. The desktop
 * and mobile apps open on sign in or the workspace, never on the public site,
 * and hand the public pages to the system browser. In a browser every helper
 * answers as the web, so the site behaves exactly as before.
 *
 * Nothing here imports Capacitor up front, because the build prerenders the
 * public pages outside a browser and this module sits under them.
 */

import { desktopBridge } from './desktop';
import {
  CONTACT_PATH,
  DOWNLOAD_PATH,
  PRICING_PATH,
  PRIVACY_PATH,
  REFUNDS_PATH,
  TERMS_PATH,
} from './paths';

/** The marker the mobile apps append to the web view's user agent. */
export const MOBILE_USER_AGENT_MARKER = 'StanduplessMobile/';

/** Where a signed out person starts inside an app. */
export const SHELL_SIGN_IN_PATH = '/login';

/** The public site's pages, which an app opens in the system browser. */
export const PUBLIC_SITE_PATHS: readonly string[] = [
  PRICING_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
  REFUNDS_PATH,
  CONTACT_PATH,
  DOWNLOAD_PATH,
];

/** The Capacitor global the mobile apps inject before the page runs. */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

/** Whether the page runs inside the iOS or Android app, read without Capacitor. */
const inMobileApp = (): boolean => {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  try {
    if (capacitor?.isNativePlatform?.() === true) return true;
  } catch {
    return false;
  }
  return (
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes(MOBILE_USER_AGENT_MARKER)
  );
};

/** Whether the page runs inside the desktop or the mobile app. */
export const isAppShell = (): boolean =>
  desktopBridge() !== null || inMobileApp();

/** The in-app browser the mobile apps ship as a native plugin. */
interface BrowserPlugin {
  open: (options: { url: string }) => Promise<void>;
}

let browserPlugin: Promise<BrowserPlugin> | null = null;

/** Registers the native Browser plugin once, on first use. */
const mobileBrowser = (): Promise<BrowserPlugin> => {
  browserPlugin ??= import('@capacitor/core').then(({ registerPlugin }) =>
    registerPlugin<BrowserPlugin>('Browser')
  );
  return browserPlugin;
};

/**
 * Opens an app path or URL in the system browser from inside an app. Desktop
 * builds that predate the bridge call, and the web, do nothing.
 */
export const openInSystemBrowser = (target: string): void => {
  const url = new URL(target, globalThis.location.origin).toString();
  const bridge = desktopBridge();
  if (bridge !== null) {
    bridge.openExternal?.(url);
    return;
  }
  if (!inMobileApp()) return;
  void mobileBrowser()
    .then((browser) => browser.open({ url }))
    .catch(() => undefined);
};
