/**
 * Builds the `@webbpulse/auth` client, lazily, so importing this module does not
 * construct a network capable object at import time.
 */

import {
  createAuthClient,
  type AuthClient,
  type WebAuthnAdapter,
} from '@webbpulse/auth';
import {
  identityOriginFrom,
  identityUrl as joinIdentityUrl,
} from '@webbpulse/discovery';
import { appConfig } from '../config/app';
import type { UserRead } from '../types/Api';

export {
  OAUTH_PROVIDERS_PATH,
  PASSKEY_AVAILABILITY_PATH,
  identityOriginFrom,
  oauthProviders,
  passkeyEnrolmentAvailability,
  passkeyLoginAvailability,
  providerLabel,
  resetAvailabilityCache,
  type Availability,
  type OAuthProviderInfo,
  type PasskeyCapabilities,
} from '@webbpulse/discovery';

/**
 * The origin the identity routes are mounted on, for the hooks that take the
 * origin rather than a built URL.
 */
export const identityOrigin = (): string =>
  identityOriginFrom(appConfig.apiBaseUrl);

/**
 * Prefixes the identity origin onto an already absolute route path, for the
 * discovery gates that fetch directly instead of through `AuthClient`.
 */
export const identityUrl = (path: string): string =>
  joinIdentityUrl(identityOrigin(), path);

/**
 * Where the signed in profile is read from. Carries the `/api` prefix because
 * `identityOriginFrom` strips the configured base URL back to a bare origin.
 */
export const CURRENT_USER_PATH = '/api/users/me';

/** The identity client as the pages take it, with the user type applied. */
export type IdentityClient = AuthClient<UserRead>;

let client: AuthClient<UserRead> | null = null;
let built = false;
let webAuthnAdapter: WebAuthnAdapter | null = null;

/**
 * Installs a WebAuthn stub for the passkey tests. Tests only, and must run
 * before the first `getIdentityClient()`.
 */
export const setWebAuthnAdapterForTests = (
  adapter: WebAuthnAdapter | null
): void => {
  webAuthnAdapter = adapter;
};

/**
 * The identity client, or null when it could not be built. Null rather than a
 * throw so a page can render its own unavailable state from the same code path.
 */
export const getIdentityClient = (): AuthClient<UserRead> | null => {
  if (built) return client;
  built = true;
  const origin = identityOriginFrom(appConfig.apiBaseUrl);
  client = createAuthClient<UserRead>({
    baseUrl: origin === '' ? globalThis.location.origin : origin,
    loadUser: (apiClient) =>
      apiClient
        .get<UserRead>(CURRENT_USER_PATH)
        .then((response) => response.data ?? null),
    clientOptions: {
      credentials: 'include',
      timeoutMs: 30000,
    },
    ...(webAuthnAdapter === null ? {} : { webAuthn: webAuthnAdapter }),
  });
  return client;
};

/** Drops the cached instance. Tests only. */
export const resetIdentityClientForTests = (): void => {
  client?.dispose();
  client = null;
  built = false;
  webAuthnAdapter = null;
};
