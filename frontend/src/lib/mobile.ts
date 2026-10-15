/**
 * What the page knows about the Standupless mobile app it may be running in.
 *
 * The iOS and Android apps load the hosted site in a web view and inject the
 * Capacitor bridge into it. The page only asks for the bridge to reach native
 * features, such as the status bar and deep links, and never to change its
 * layout, which follows the viewport like any other small screen.
 */

import { Capacitor } from '@capacitor/core';

/** Whether the page runs inside the iOS or Android app. */
export const isMobileShell = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

/** The custom scheme host the sign-in handoff owns. */
const HANDOFF_HOST = 'auth';

/**
 * The in-app path a link that opened the app points at, or null when the app
 * should ignore it. Links arrive as `https://<app host>/...` App Links and
 * universal links, or as `<scheme>://<path>` custom scheme links. The sign-in
 * handoff's `<scheme>://auth/...` links carry a one-time code and are never
 * routed into the page, so the code cannot end up in history or the address.
 */
export const mobileLinkPath = (
  url: string,
  appOrigin: string = globalThis.location.origin
): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  let path: string;
  if (parsed.protocol === 'https:') {
    if (parsed.origin !== appOrigin) return null;
    path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } else if (parsed.protocol === 'http:') {
    return null;
  } else {
    if (parsed.host === HANDOFF_HOST) return null;
    const rest = `${parsed.host}${parsed.pathname}`.replace(/^\/+/, '');
    path = `/${rest}${parsed.search}${parsed.hash}`;
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
};
