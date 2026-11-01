/**
 * The bridge the Standupless desktop app exposes to the page, and the few
 * questions the web app asks of it. In a browser there is no bridge, every
 * helper answers as the web, and nothing here changes how the site behaves.
 * The installers the download page offers, and the platform it offers first,
 * live here too.
 */

/** The fixed `desktop-latest` release the desktop builds are served from. */
export const DESKTOP_RELEASE_URL =
  'https://github.com/WebbPulse/Standupless/releases/tag/desktop-latest';

/** Where a file on the `desktop-latest` release downloads from. */
const DESKTOP_ASSET_BASE =
  'https://github.com/WebbPulse/Standupless/releases/download/desktop-latest';

/** The desktop operating systems a build exists for. */
export type DesktopPlatform = 'mac' | 'windows' | 'linux';

/** One installer on the `desktop-latest` release. */
export interface DesktopBuild {
  platform: DesktopPlatform;
  /** The operating system, as the page names it. */
  label: string;
  /** The installer format and the machines it runs on. */
  detail: string;
  /** The file name, fixed across versions so the link never goes stale. */
  fileName: string;
  href: string;
}

/** A build's link, from its fixed file name. */
const build = (
  platform: DesktopPlatform,
  label: string,
  detail: string,
  fileName: string
): DesktopBuild => ({
  platform,
  label,
  detail,
  fileName,
  href: `${DESKTOP_ASSET_BASE}/${fileName}`,
});

/**
 * Every installer, in the order the page lists them. The release workflow
 * uploads each under these version free names beside the versioned files.
 */
export const DESKTOP_BUILDS: readonly DesktopBuild[] = [
  build(
    'mac',
    'macOS',
    'Disk image, Apple silicon and Intel',
    'Standupless-mac.dmg'
  ),
  build(
    'windows',
    'Windows',
    'Installer, x64 and Arm',
    'Standupless-Setup.exe'
  ),
  build('linux', 'Linux', 'AppImage, x64', 'Standupless.AppImage'),
  build(
    'linux',
    'Debian and Ubuntu',
    'Package, x64',
    'standupless-desktop_amd64.deb'
  ),
];

/** The app store listings, null until each exists, which hides its badge. */
export const MOBILE_STORE_URLS: {
  appStore: string | null;
  googlePlay: string | null;
} = { appStore: null, googlePlay: null };

/**
 * The desktop platform a browser runs on, or null for a phone, a tablet or
 * anything not recognised, which then sees every build with none first. The
 * platform hint wins over the user agent, which browsers freeze or spoof.
 */
export const detectDesktopPlatform = (
  userAgent: string,
  platform = ''
): DesktopPlatform | null => {
  const agent = userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod|mobile/.test(agent)) return null;
  const os = platform.toLowerCase();
  if (os.startsWith('mac')) return 'mac';
  if (os.startsWith('win')) return 'windows';
  if (os.includes('linux')) return 'linux';
  if (agent.includes('mac os x')) return 'mac';
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

/**
 * The desktop platform this browser runs on, or null outside a browser. An
 * iPad asking for the desktop site reports a Mac, so a touch screen that
 * claims to be one counts as no desktop.
 */
export const currentDesktopPlatform = (): DesktopPlatform | null => {
  if (typeof navigator === 'undefined') return null;
  const hinted = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const detected = detectDesktopPlatform(
    navigator.userAgent,
    hinted ?? navigator.platform
  );
  if (detected === 'mac' && navigator.maxTouchPoints > 1) return null;
  return detected;
};

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
  setBadgeCount: (count: number) => void;
  notify: (payload: DesktopNotification) => void;
  setTheme: (theme: 'system' | 'light' | 'dark') => void;
  onNavigate: (listener: (path: string) => void) => () => void;
  /**
   * Opens the system browser to sign in there and hand the session back
   * through the app's URL scheme. Absent on builds that predate the handoff.
   */
  signInWithBrowser?: () => void;
  /**
   * Finishes a browser sign-in from a link pasted into the app, for a browser
   * that could not open the app's URL scheme. Absent on older builds.
   */
  completeSignInLink?: (link: string) => void;
  /**
   * Opens a web or mail link in the system browser. Absent on builds that
   * predate it.
   */
  openExternal?: (url: string) => void;
  /** Whether the app shows the page in tabs. Absent on builds without them. */
  tabs?: boolean;
  /**
   * Opens an app path in a new background tab. Absent on builds without tabs.
   */
  openInNewTab?: (path: string) => void;
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
 * The desktop app's browser sign-in, or null in a browser or on a desktop
 * build that predates the handoff.
 */
export const desktopBrowserSignIn = (): (() => void) | null => {
  const bridge = desktopBridge();
  return typeof bridge?.signInWithBrowser === 'function'
    ? () => bridge.signInWithBrowser?.()
    : null;
};

/** Whether the page runs in a desktop app tab, so it names itself for one. */
export const desktopHasTabs = (): boolean => desktopBridge()?.tabs === true;

/**
 * The desktop app's open in new tab, or null in a browser or on a desktop
 * build without tabs, where no menu offers it.
 */
export const desktopOpenInNewTab = (): ((path: string) => void) | null => {
  const bridge = desktopBridge();
  return typeof bridge?.openInNewTab === 'function'
    ? (path: string) => bridge.openInNewTab?.(path)
    : null;
};

/** The reasons a browser sign-in failed that have a sentence of their own. */
const HANDOFF_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  'rate-limited':
    'Too many sign-in attempts from the app. Wait a few minutes, then try again.',
  refused:
    'That account cannot sign in to the app. Try again with another account.',
  expired: 'The browser sign-in expired before it finished. Try again.',
  'browser-unavailable': 'The browser could not be opened. Try again.',
  'invalid-link':
    'That is not a Standupless sign-in link. Copy it again from the browser.',
};

/**
 * What the app's sign-in screen says when a browser sign-in did not finish, by
 * the reason in the query. Any failure has already spent the code, so every
 * message leads to the retry on that screen.
 */
export const describeDesktopHandoffFailure = (
  reason: string | null
): string | null => {
  if (reason === null || reason === '') return null;
  return (
    HANDOFF_FAILURE_MESSAGES[reason] ??
    'The browser sign-in could not be completed. Try again.'
  );
};
