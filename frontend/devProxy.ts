/**
 * Dev server settings. The browser always calls the relative `/api` base on
 * the dev server, and the dev server proxies it to the backend `VITE_BACKEND`
 * names: the local backend by default, or the deployed staging or production
 * API. Proxying keeps the browser same origin, so a deployed API's CORS list
 * never needs to admit localhost.
 */

import type { ProxyOptions, ServerOptions } from 'vite';

/** The watcher settings the dev server takes. */
type WatchOptions = NonNullable<ServerOptions['watch']>;

/** The local backend `npm run dev` proxies to. */
const LOCAL_API_URL = 'http://localhost:8000';

/** A deployed environment the dev server can proxy to. */
interface DeployedBackend {
  /** The API origin requests are forwarded to. */
  apiUrl: string;
  /** The site origin the API expects in Origin and Referer. */
  siteOrigin: string;
  /** The variable that overrides `apiUrl`. */
  overrideKey: string;
}

/** The deployed environments `VITE_BACKEND` selects. */
const DEPLOYED_BACKENDS: Record<string, DeployedBackend> = {
  production: {
    apiUrl: 'https://api.standupless.dev',
    siteOrigin: 'https://standupless.dev',
    overrideKey: 'VITE_PROD_API_URL',
  },
  staging: {
    apiUrl: 'https://api.staging.standupless.dev',
    siteOrigin: 'https://staging.standupless.dev',
    overrideKey: 'VITE_STAGING_API_URL',
  },
};

/** Reads one variable, treating blank as unset. */
const read = (
  env: Record<string, string | undefined>,
  key: string
): string | undefined => {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

/**
 * Builds the `/api` proxy for the backend `VITE_BACKEND` names. A deployed
 * target gets its host, cookie domain and the Origin and Referer headers
 * rewritten, so the API sees what the deployed site would send and its
 * cookies land on localhost. An unknown name is an error rather than a silent
 * fall back to the local backend.
 */
export const apiProxy = (
  env: Record<string, string | undefined>
): Record<string, ProxyOptions> => {
  const name = read(env, 'VITE_BACKEND')?.toLowerCase();
  if (name === undefined || name === 'local') {
    return { '/api': { target: LOCAL_API_URL, changeOrigin: true } };
  }
  const backend = DEPLOYED_BACKENDS[name];
  if (backend === undefined) {
    throw new Error(
      `VITE_BACKEND must be local, staging or production, not ${name}`
    );
  }
  const target = read(env, backend.overrideKey) ?? backend.apiUrl;
  return {
    '/api': {
      target,
      changeOrigin: true,
      secure: true,
      cookieDomainRewrite: { '*': '' },
      configure: (proxy) => {
        proxy.on('proxyReq', (request) => {
          if (request.getHeader('origin') !== undefined) {
            request.setHeader('origin', backend.siteOrigin);
          }
          const referer = request.getHeader('referer');
          if (typeof referer === 'string') {
            try {
              const url = new URL(referer);
              request.setHeader(
                'referer',
                `${backend.siteOrigin}${url.pathname}${url.search}`
              );
            } catch {
              request.setHeader('referer', `${backend.siteOrigin}/`);
            }
          }
        });
      },
    },
  };
};

/**
 * The dev server's file watcher. Setting `DEV_WATCH_POLLING=1` swaps native
 * file events for polling, for a machine whose inotify watch limit is too low
 * for the project and crashes the dev server with ENOSPC.
 */
export const devWatch = (
  env: Record<string, string | undefined>
): WatchOptions | undefined => {
  const polling = read(env, 'DEV_WATCH_POLLING')?.toLowerCase();
  if (polling === undefined || ['0', 'false', 'no'].includes(polling)) {
    return undefined;
  }
  return { usePolling: true, interval: 300 };
};
