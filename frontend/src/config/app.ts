/**
 * Runtime app configuration read from the Vite environment.
 */

import { loadAppConfig, type AppConfig } from '@webbpulse/config';

/** The production API origin, which the CLI targets with no flag. */
export const PRODUCTION_API_URL = 'https://api.standupless.dev';

/** The staging API origin, which the CLI targets with `--env staging`. */
export const STAGING_API_URL = 'https://api.staging.standupless.dev';

/**
 * Loads and validates the configuration for an environment bag. Exported apart
 * from the singleton so tests can pass a synthetic bag. `VITE_BACKEND` is not
 * read here: the dev server proxies `/api` to the backend it names, so the
 * browser keeps the relative base and never needs a deployed API's CORS.
 */
export const loadStanduplessConfig = (env: ImportMetaEnv): AppConfig =>
  loadAppConfig(env, {
    apiBaseUrlAliases: ['VITE_API_URL'],
    assumeHttps: true,
    defaultApiBaseUrl: '/api',
    defaultAppName: 'Standupless',
    apiPathPrefix: '/api',
  });

/** The resolved configuration this bundle holds for its lifetime. */
export const appConfig: AppConfig = loadStanduplessConfig(import.meta.env);

/**
 * Parses the desktop handoff schemes from a comma separated or JSON array
 * value, dropping blanks. Unset or blank is an empty list, which leaves the
 * browser to desktop sign-in handoff off.
 */
export const parseDesktopHandoffSchemes = (value: unknown): string[] => {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const raw = value.trim();
  let entries: unknown[] = raw.split(',');
  if (raw.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = [];
    }
  }
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
};

/** The custom URL schemes this build may hand a desktop sign-in to. */
export const desktopHandoffSchemes: readonly string[] =
  parseDesktopHandoffSchemes(import.meta.env['VITE_DESKTOP_HANDOFF_SCHEMES']);
