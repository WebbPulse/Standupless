/**
 * Single sign-on as the browser sees it: the flags the identity service adds
 * to the return URL, the sentences its refusal codes read as, and the steps
 * that start a sign-in and finish one by joining the workspace that owns the
 * connection.
 *
 * Every start returns through the sign-in page, so a second factor the
 * account holds is answered there with the existing challenge, and a refusal
 * is shown there next to the password form.
 */

import { ApiError } from '@webbpulse/api-client';
import { startSsoSignIn } from '../api/sso';
import { joinSsoWorkspace } from '../api/workspaces';
import { errorCode, errorMessage } from './errors';
import { showErrorToast } from './toast';
import type { SsoConnectionField, SsoJoinRead } from '../types/Api';

/** The query flag a finished single sign-on lands with. */
export const SSO_PARAM = 'sso';

/** The query parameter carrying the code of a single sign-on that did not finish. */
export const SSO_ERROR_PARAM = 'sso_error';

/** The query flag a settings test sign-in returns with. */
export const SSO_TEST_PARAM = 'sso_test';

/** The query flag marking a sign-in page visit as the end of a single sign-on. */
export const SSO_LOGIN_PARAM = 'sso_login';

/** The code `POST /auth/sso/start` answers when no connection matched. */
export const SSO_CONNECTION_NOT_FOUND = 'SSO_CONNECTION_NOT_FOUND';

/** The code the join and test routes answer for a session not from single sign-on. */
export const SSO_SESSION_REQUIRED = 'SSO_SESSION_REQUIRED';

/** The code the test route answers when the session came from elsewhere. */
export const SSO_TEST_REQUIRED = 'SSO_TEST_REQUIRED';

/** The code a connection save answers when one field cannot be used. */
export const SSO_CONNECTION_INVALID = 'SSO_CONNECTION_INVALID';

/** The pages a finished single sign-on may move on from into its workspace. */
const LANDING_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/workspaces',
  '/login',
]);

const SSO_ERROR_MESSAGES: Record<string, string> = {
  SSO_CANCELLED: 'Sign-in was cancelled.',
};

/** What the sign-in page says when no connection matches the email domain. */
export const SSO_NOT_FOUND_MESSAGE =
  'No single sign-on is set up for that email domain. Use your password instead.';

const SSO_ERROR_FALLBACK =
  'Single sign-on did not complete. Try again or contact your workspace admin.';

const CONNECTION_FIELDS: ReadonlySet<string> = new Set<SsoConnectionField>([
  'oidc_issuer',
  'oidc_client_id',
  'oidc_client_secret',
  'saml_metadata_xml',
  'saml_idp_entity_id',
  'saml_idp_sso_url',
  'saml_idp_certificate',
]);

/** The sentence a single sign-on refusal code reads as, or null without a code. */
export const describeSsoError = (code: string | null): string | null => {
  if (code === null || code === '') return null;
  return SSO_ERROR_MESSAGES[code] ?? SSO_ERROR_FALLBACK;
};

/**
 * The sign-in page URL a single sign-on returns to, carrying where to go once
 * it finishes.
 */
export const ssoLoginReturn = (returnTo: string): string => {
  const params = new URLSearchParams({ returnTo, [SSO_LOGIN_PARAM]: '1' });
  return `/login?${params.toString()}`;
};

/** How to find the connection a sign-in starts at, and where to land after. */
export interface BeginSsoOptions {
  /** The address whose domain names the connection. */
  email?: string;
  /** The workspace whose connection to use. */
  connectionId?: string;
  /** The in-app path to land on once signed in. */
  returnTo: string;
  /**
   * Ends the current session before the browser leaves, so the sign-in page
   * can take the new one, including its second factor.
   */
  signOut?: () => Promise<void>;
}

/**
 * Starts a single sign-on and sends the browser to the identity provider.
 * Rejects with the start route's error, such as a 404
 * `SSO_CONNECTION_NOT_FOUND`, before anything is signed out.
 */
export const beginSso = async ({
  email,
  connectionId,
  returnTo,
  signOut,
}: BeginSsoOptions): Promise<void> => {
  const started = await startSsoSignIn({
    ...(email === undefined ? {} : { email }),
    ...(connectionId === undefined ? {} : { connection_id: connectionId }),
    return_to: ssoLoginReturn(returnTo),
  });
  if (signOut !== undefined) await signOut();
  window.location.assign(started.authorization_url);
};

/** Whether a failure was the start route finding no connection. */
export const isSsoConnectionNotFound = (error: unknown): boolean =>
  error instanceof ApiError &&
  (errorCode(error) === SSO_CONNECTION_NOT_FOUND || error.status === 404);

/**
 * The connection field a `SSO_CONNECTION_INVALID` refusal names, or null for
 * any other failure.
 */
export const ssoInvalidField = (error: unknown): SsoConnectionField | null => {
  if (!(error instanceof ApiError)) return null;
  if (errorCode(error) !== SSO_CONNECTION_INVALID) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const details = record['details'];
  const nested =
    typeof details === 'object' && details !== null && !Array.isArray(details)
      ? (details as Record<string, unknown>)['field']
      : undefined;
  const field = record['field'] ?? nested;
  return typeof field === 'string' && CONNECTION_FIELDS.has(field)
    ? (field as SsoConnectionField)
    : null;
};

/**
 * Joins the workspace the session's connection belongs to. Answers null for a
 * session that did not come through single sign-on, and raises the error toast
 * for any other refusal.
 */
export const joinSsoSession = async (): Promise<SsoJoinRead | null> => {
  try {
    return await joinSsoWorkspace();
  } catch (error) {
    if (errorCode(error) !== SSO_SESSION_REQUIRED) {
      showErrorToast(
        errorMessage(error, 'Could not open the workspace you signed in to.')
      );
    }
    return null;
  }
};

/**
 * Finishes a single sign-on: joins its workspace, then moves into it when the
 * person is still on a page that only lists workspaces. `currentPath` is read
 * once the join answers, so a redirect made meanwhile is respected.
 */
export const landAfterSso = async (
  go: (path: string) => void,
  currentPath: () => string
): Promise<void> => {
  const joined = await joinSsoSession();
  if (joined === null) return;
  if (LANDING_PATHS.has(currentPath())) go(`/w/${joined.slug}`);
};
