/**
 * Builds the `@webbpulse/auth` client, lazily, so importing this module does not
 * construct a network capable object at import time. The singleton is the
 * package's; this module is the Standupless settings plus the names the rest of
 * `src` imports.
 */

import type { AuthClient } from '@webbpulse/auth';
import { createIdentityClientSingleton } from '@webbpulse/auth/browser';
import { appConfig, desktopHandoffSchemes } from '../config/app';
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
 * Where the signed in profile is read from. Carries the `/api` prefix because
 * the configured base URL is stripped back to a bare origin.
 */
export const CURRENT_USER_PATH = '/api/users/me';

/** The identity client as the pages take it, with the user type applied. */
export type IdentityClient = AuthClient<UserRead>;

const identity = createIdentityClientSingleton<UserRead>({
  apiBaseUrl: () => appConfig.apiBaseUrl,
  currentUserPath: CURRENT_USER_PATH,
  authClientOptions: { desktopHandoffSchemes },
});

/**
 * The identity client, or null when it could not be built. Null rather than a
 * throw so a page can render its own unavailable state from the same code path.
 * One instance per page, shared by the provider, the panels and the API client.
 */
export const getIdentityClient = identity.getClient;

/**
 * The origin the identity routes are mounted on, for the hooks that take the
 * origin rather than a built URL.
 */
export const identityOrigin = identity.identityOrigin;

/**
 * Prefixes the identity origin onto an already absolute route path, for the
 * discovery gates that fetch directly instead of through `AuthClient`.
 */
export const identityUrl = identity.identityUrl;

/**
 * Installs a WebAuthn stub for the passkey tests. Tests only, and must run
 * before the first `getIdentityClient()`.
 */
export const setWebAuthnAdapterForTests = identity.setWebAuthnAdapterForTests;

/** Drops the cached instance. Tests only. */
export const resetIdentityClientForTests = identity.resetForTests;
