/**
 * The navigation policy, kept free of Electron so every rule is a pure
 * function of a URL and the environment.
 *
 * The window only ever shows the app and API origins. An OAuth sign-in leaves
 * them for the provider's pages, so a navigation to the API's OAuth start
 * route opens a short sign-in window in which the provider hosts are allowed
 * too, closed again as soon as the window lands back on the app origin.
 */

import type { Environment } from './environment';

/** The hosts an OAuth sign-in passes through. */
export const OAUTH_HOSTS: ReadonlySet<string> = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'github.com',
]);

/** The API path prefix every OAuth route lives under. */
const OAUTH_PATH = '/api/auth/oauth/';

/** The schemes the shell hands to the operating system. */
const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
]);

/** Parses a URL, or returns null when it does not parse. */
export const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** Whether a URL is on the web app's origin. */
export const isAppUrl = (value: string, env: Environment): boolean =>
  parseUrl(value)?.origin === env.appOrigin;

/** Whether a URL is on the API's origin. */
export const isApiUrl = (value: string, env: Environment): boolean =>
  parseUrl(value)?.origin === env.apiOrigin;

/** Whether a URL starts or finishes an OAuth sign-in on the API. */
export const isOAuthRoute = (value: string, env: Environment): boolean => {
  const url = parseUrl(value);
  return (
    url !== null &&
    url.origin === env.apiOrigin &&
    url.pathname.startsWith(OAUTH_PATH)
  );
};

/** Whether a URL is on an OAuth provider's host, over https. */
export const isOAuthProviderUrl = (value: string): boolean => {
  const url = parseUrl(value);
  return url !== null && url.protocol === 'https:' && OAUTH_HOSTS.has(url.host);
};

/** What the shell does with a navigation the page asked for. */
export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * Decides a top-level navigation. The app and API origins always load in the
 * window, a provider host loads only during a sign-in, any other web or mail
 * link goes to the default browser, and everything else is dropped.
 */
export const decideNavigation = (
  value: string,
  env: Environment,
  signingIn: boolean
): NavigationDecision => {
  if (isAppUrl(value, env) || isApiUrl(value, env)) return 'allow';
  if (signingIn && isOAuthProviderUrl(value)) return 'allow';
  return isExternalUrl(value) ? 'external' : 'block';
};

/** Whether a URL is one the operating system should open. */
export const isExternalUrl = (value: string): boolean => {
  const url = parseUrl(value);
  return url !== null && EXTERNAL_SCHEMES.has(url.protocol);
};

/**
 * Whether the sign-in window is open after the window moves to `value`. It
 * opens on the API's OAuth routes and closes on the app origin, so a provider
 * page reached any other way opens in the default browser.
 */
export const nextSigningIn = (
  value: string,
  env: Environment,
  signingIn: boolean
): boolean => {
  if (isOAuthRoute(value, env)) return true;
  if (isAppUrl(value, env)) return false;
  return signingIn;
};

/** Whether a path is a same-origin app path, not a protocol-relative URL. */
export const isAppPath = (path: string): boolean =>
  path.startsWith('/') && !path.startsWith('//') && !path.includes('\\');

/**
 * Turns a deep link into an app URL. `standupless://w/acme/issue/ENG-1` and
 * `https://standupless.dev/w/acme/issue/ENG-1` both open
 * `/w/acme/issue/ENG-1`. Anything else is null.
 */
export const deepLinkToAppUrl = (
  value: string,
  env: Environment
): string | null => {
  const url = parseUrl(value);
  if (url === null) return null;
  if (url.protocol === `${env.scheme}:`) {
    const rest = value.slice(`${env.scheme}:`.length).replace(/^\/+/, '');
    const path = `/${rest}`;
    if (!isAppPath(path)) return null;
    const target = parseUrl(`${env.appOrigin}${path}`);
    return target !== null && target.origin === env.appOrigin
      ? target.toString()
      : null;
  }
  return url.origin === env.appOrigin ? url.toString() : null;
};

/** Picks the first deep link out of a command line, for the second instance. */
export const deepLinkFromArgv = (
  argv: readonly string[],
  env: Environment
): string | null => {
  for (const arg of argv) {
    const target = deepLinkToAppUrl(arg, env);
    if (target !== null) return target;
  }
  return null;
};
