/**
 * The MCP authorization hand-off: the API sends a browser with no session to
 * `/login?returnTo=<authorize url>`, and the login page sends it back there once
 * signed in. The return is honoured only when it is exactly the API's own
 * authorize endpoint, so the page is never an open redirect.
 */

import { identityReturnUrl } from '@webbpulse/auth';

/** The authorization server's authorize route under the identity issuer. */
export const AUTHORIZE_PATH = '/api/auth/authorize';

/**
 * The authorize URL to hand the browser back to, or null when `value` is not an
 * absolute URL on `identityOrigin` whose path is exactly the authorize route.
 * Credentials and fragments in the URL are refused rather than stripped.
 */
export const authorizeReturn = (
  value: string | null,
  identityOrigin: string
): string | null =>
  identityReturnUrl(value, { identityOrigin, path: AUTHORIZE_PATH });

/**
 * Whether the API asked for a fresh sign in, which a signed in visitor must not
 * skip by being bounced straight back to the authorize URL.
 */
export const wantsFreshLogin = (params: URLSearchParams): boolean =>
  params.get('prompt') === 'login';

/**
 * The `returnTo` a provider sign in should land on so the login page, and so
 * this hand-off, runs again after the provider callback.
 */
export const loginReturnFor = (authorizeUrl: string): string =>
  `/login?returnTo=${encodeURIComponent(authorizeUrl)}`;
