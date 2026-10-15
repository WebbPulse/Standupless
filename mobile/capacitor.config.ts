/**
 * Capacitor configuration for the Standupless mobile shells.
 *
 * The shells bundle no web app: the web view loads the hosted app, so mobile
 * always runs whatever the web release is serving. `STANDUPLESS_MOBILE_ENV`
 * picks the environment when `cap sync` copies this file into the native
 * projects. `staging` loads staging.standupless.dev under its own app id and
 * URL scheme, so it installs beside the production app.
 *
 * The Android build reads `plugins.Standupless` back out of the synced copy
 * for its application id, scheme and link host, so an APK can never point at
 * one environment while it registers the other's links. The iOS project keeps
 * production values in its build settings and takes `ios/App/Staging.xcconfig`
 * for a staging build.
 */

import type { CapacitorConfig } from '@capacitor/cli';
import { resolveEnvironment } from './src/environment';

const env = resolveEnvironment(process.env.STANDUPLESS_MOBILE_ENV);

const config: CapacitorConfig = {
  appId: env.appId,
  appName: env.appName,
  webDir: 'www',
  backgroundColor: '#141518',
  loggingBehavior: env.name === 'staging' ? 'debug' : 'none',
  server: {
    url: env.appOrigin,
    allowNavigation: [new URL(env.appOrigin).host],
    errorPath: 'offline.html',
  },
  ios: {
    contentInset: 'never',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
    preferredContentMode: 'mobile',
    appendUserAgent: `StanduplessMobile/${env.name}`,
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: env.name === 'staging',
    appendUserAgent: `StanduplessMobile/${env.name}`,
  },
  plugins: {
    Standupless: {
      environment: env.name,
      appId: env.appId,
      appName: env.appName,
      scheme: env.scheme,
      appHost: new URL(env.appOrigin).host,
    },
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
      style: 'DARK',
    },
    SplashScreen: {
      launchShowDuration: 4000,
      launchAutoHide: true,
      launchFadeOutDuration: 200,
      backgroundColor: '#141518',
      showSpinner: false,
      androidScaleType: 'CENTER_INSIDE',
      splashFullScreen: false,
      splashImmersive: false,
    },
    Keyboard: {
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
