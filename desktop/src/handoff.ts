/**
 * Signing in through the system browser, for the providers and passkey
 * ceremonies the app window cannot finish. The main process makes a PKCE pair,
 * keeps the verifier in memory, and opens the web app's handoff page in the
 * default browser with the challenge. The signed in browser hands a single-use
 * code back on `<scheme>://auth/handoff`, and the main process redeems it with
 * the verifier through the default session, so the refresh cookie the exchange
 * sets lands in the same cookie jar the window's page refreshes from. The page
 * itself never sees the verifier or the code.
 *
 * The exchange runs here rather than in the page because a cross-site renderer
 * fetch is refused, and because a verifier held by remote content is one a
 * script on that content could read.
 */

import { session, shell } from 'electron';
import type { Environment } from './environment';

/** The `@webbpulse/auth` module, which ships as ES modules only. */
type AuthModule = typeof import('@webbpulse/auth', {
  with: { 'resolution-mode': 'import' },
});

/** How long a browser sign-in may take before its verifier is discarded. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** The query parameter the sign-in page reads a failed handoff's reason from. */
export const HANDOFF_FAILED_PARAM = 'desktop_handoff';

/** Where the window goes once a handoff signs in. */
const SIGNED_IN_PATH = '/workspaces';

/** The verifier of the one browser sign-in in flight, if any. */
let pending: { verifier: string; startedAt: number } | null = null;

/** Loads `@webbpulse/auth` from this CommonJS build. */
const loadAuth = (): Promise<AuthModule> => import('@webbpulse/auth');

/** Takes the pending verifier, once, or null when none is pending or it expired. */
const takeVerifier = (): string | null => {
  const current = pending;
  pending = null;
  if (current === null) return null;
  return Date.now() - current.startedAt <= PENDING_TTL_MS
    ? current.verifier
    : null;
};

/** The sign-in page, saying why a handoff did not finish. */
export const handoffFailedUrl = (env: Environment, reason: string): string => {
  const url = new URL('/login', env.appOrigin);
  url.searchParams.set(HANDOFF_FAILED_PARAM, reason);
  return url.toString();
};

/**
 * Starts a browser sign-in: a fresh PKCE pair, its verifier kept here, and the
 * handoff page opened in the default browser. A second start replaces the
 * first, so only the newest browser tab can finish.
 */
export const startBrowserSignIn = async (env: Environment): Promise<void> => {
  const auth = await loadAuth();
  const pkce = await auth.createDesktopHandoffPkce();
  pending = { verifier: pkce.verifier, startedAt: Date.now() };
  const url = auth.desktopHandoffLaunchUrl({
    origin: env.appOrigin,
    challenge: pkce.challenge,
    scheme: env.scheme,
    allowedSchemes: [env.scheme],
  });
  await shell.openExternal(url);
};

/**
 * Redeems a handoff callback and answers the app URL the window should load:
 * the workspaces on success, or the sign-in page with the reason on failure.
 * Any failure spends the code, so the page tells the person to start again.
 */
export const completeBrowserSignIn = async (
  link: string,
  env: Environment
): Promise<string> => {
  const verifier = takeVerifier();
  if (verifier === null) return handoffFailedUrl(env, 'expired');
  const auth = await loadAuth();
  const client = auth.createAuthClient({
    baseUrl: env.apiOrigin,
    desktopHandoffSchemes: [env.scheme],
    disableProactiveRefresh: true,
    clientOptions: {
      credentials: 'include',
      fetch: (input, init) =>
        session.defaultSession.fetch(
          input instanceof URL ? input.toString() : input,
          init
        ),
    },
  });
  try {
    const outcome = await client.completeDesktopHandoff({
      url: link,
      codeVerifier: verifier,
    });
    return outcome.ok
      ? new URL(SIGNED_IN_PATH, env.appOrigin).toString()
      : handoffFailedUrl(env, outcome.reason);
  } catch {
    return handoffFailedUrl(env, 'failed');
  } finally {
    client.dispose();
  }
};
