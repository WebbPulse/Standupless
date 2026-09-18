/**
 * Runtime app configuration read from the Vite environment.
 */

import { loadAppConfig, type AppConfig } from '@webbpulse/config';

/**
 * Reads a URL variable, treating blank as unset, which the package's own target
 * resolution does not do.
 */
const readEnvUrl = (env: ImportMetaEnv, key: string): string | undefined => {
  const value: unknown = env[key];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
};

/**
 * Ensures a protocol on a URL from the environment, which the deploy writes as
 * a bare host in some environments.
 */
const withProtocol = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  return url.startsWith('http://') || url.startsWith('https://')
    ? url
    : `https://${url}`;
};

/** The production API origin, used when `VITE_BACKEND=production` under dev. */
export const PRODUCTION_API_URL = 'https://api.standupless.dev';

/** The staging API origin, used when `VITE_BACKEND=staging` under dev. */
export const STAGING_API_URL = 'https://api.staging.standupless.dev';

/**
 * Loads and validates the configuration for an environment bag. Exported apart
 * from the singleton so tests can pass a synthetic bag. `backendTargets` is
 * honoured only under `DEV`, so a stray `VITE_BACKEND` cannot repoint a build.
 */
export const loadStanduplessConfig = (env: ImportMetaEnv): AppConfig =>
  loadAppConfig(
    {
      ...env,
      VITE_API_BASE_URL: withProtocol(readEnvUrl(env, 'VITE_API_URL')),
    },
    {
      defaultApiBaseUrl: '/api',
      defaultAppName: 'Standupless',
      backendTargets: {
        staging:
          withProtocol(readEnvUrl(env, 'VITE_STAGING_API_URL')) ??
          STAGING_API_URL,
        production:
          withProtocol(readEnvUrl(env, 'VITE_PROD_API_URL')) ??
          PRODUCTION_API_URL,
      },
      apiPathPrefix: '/api',
    }
  );

/** The resolved configuration this bundle holds for its lifetime. */
export const appConfig: AppConfig = loadStanduplessConfig(import.meta.env);
