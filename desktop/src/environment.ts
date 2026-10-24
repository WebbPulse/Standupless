/**
 * The hosted environment a build loads. A packaged build reads its environment
 * from the `standupless.environment` field electron-builder writes into the
 * packaged package.json, so a staging build can never point at production. An
 * unpackaged run may override it with `STANDUPLESS_DESKTOP_ENV`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The environments a build can target. */
export type EnvironmentName = 'production' | 'staging';

/** Everything the shell needs to know about the environment it loads. */
export interface Environment {
  name: EnvironmentName;
  /** The origin the web app is served from. */
  appOrigin: string;
  /** The origin the API is served from. */
  apiOrigin: string;
  /** The custom URL scheme deep links arrive on. */
  scheme: string;
  /** Whether this build checks the `desktop-latest` release for updates. */
  autoUpdate: boolean;
  /** The refresh cookie, whose arrival or removal means a sign-in or sign-out. */
  refreshCookie: string;
}

/** The two hosted environments. */
export const ENVIRONMENTS: Readonly<Record<EnvironmentName, Environment>> = {
  production: {
    name: 'production',
    appOrigin: 'https://standupless.dev',
    apiOrigin: 'https://api.standupless.dev',
    scheme: 'standupless',
    autoUpdate: true,
    refreshCookie: 'wp_refresh',
  },
  staging: {
    name: 'staging',
    appOrigin: 'https://staging.standupless.dev',
    apiOrigin: 'https://api.staging.standupless.dev',
    scheme: 'standupless-staging',
    autoUpdate: false,
    refreshCookie: 'wp_refresh_staging',
  },
};

/** Narrows a value to an environment name, defaulting to production. */
export const parseEnvironmentName = (value: unknown): EnvironmentName =>
  value === 'staging' ? 'staging' : 'production';

/** Reads the environment baked into the app's package.json. */
const packagedEnvironment = (appPath: string): unknown => {
  try {
    const raw = readFileSync(join(appPath, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as {
      standupless?: { environment?: unknown };
    };
    return manifest.standupless?.environment;
  } catch {
    return undefined;
  }
};

/** Resolves the environment for this run. */
export const resolveEnvironment = (
  appPath: string,
  packaged: boolean
): Environment => {
  const override = packaged ? undefined : process.env.STANDUPLESS_DESKTOP_ENV;
  return ENVIRONMENTS[
    parseEnvironmentName(override ?? packagedEnvironment(appPath))
  ];
};

/**
 * The web app's download page, which links every build from the fixed
 * `desktop-latest` release and says how to open an unsigned one.
 */
export const downloadsUrl = (env: Environment): string =>
  new URL('/download', env.appOrigin).toString();
