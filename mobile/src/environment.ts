/**
 * The hosted environments a mobile build can load, kept as plain data so the
 * Capacitor configuration and the build scripts read the same values.
 */

/** The environments a build can target. */
export type EnvironmentName = 'production' | 'staging';

/** Everything a native shell needs to know about the environment it loads. */
export interface Environment {
  name: EnvironmentName;
  /** The bundle id on iOS and the application id on Android. */
  appId: string;
  /** The name under the home screen icon. */
  appName: string;
  /** The origin the web app is served from, and the only one it navigates. */
  appOrigin: string;
  /** The custom URL scheme deep links and sign-in handoffs arrive on. */
  scheme: string;
}

/** The two hosted environments. */
export const ENVIRONMENTS: Readonly<Record<EnvironmentName, Environment>> = {
  production: {
    name: 'production',
    appId: 'dev.standupless.app',
    appName: 'Standupless',
    appOrigin: 'https://standupless.dev',
    scheme: 'standupless',
  },
  staging: {
    name: 'staging',
    appId: 'dev.standupless.app.staging',
    appName: 'Standupless Staging',
    appOrigin: 'https://staging.standupless.dev',
    scheme: 'standupless-staging',
  },
};

/** Narrows a value to an environment, defaulting to production. */
export const resolveEnvironment = (value: unknown): Environment =>
  ENVIRONMENTS[value === 'staging' ? 'staging' : 'production'];
