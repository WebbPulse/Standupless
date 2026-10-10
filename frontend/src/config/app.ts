/**
 * Runtime app configuration read from the Vite environment.
 */

import { loadAppConfig, type AppConfig } from '@webbpulse/config';

/** A URL variable from the environment, treating blank as unset. */
const readEnvUrl = (env: ImportMetaEnv, key: string): string | undefined => {
  const value: unknown = env[key];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
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
  loadAppConfig(env, {
    apiBaseUrlAliases: ['VITE_API_URL'],
    assumeHttps: true,
    defaultApiBaseUrl: '/api',
    defaultAppName: 'Standupless',
    backendTargets: {
      staging: readEnvUrl(env, 'VITE_STAGING_API_URL') ?? STAGING_API_URL,
      production: readEnvUrl(env, 'VITE_PROD_API_URL') ?? PRODUCTION_API_URL,
    },
    apiPathPrefix: '/api',
  });

/** The resolved configuration this bundle holds for its lifetime. */
export const appConfig: AppConfig = loadStanduplessConfig(import.meta.env);
