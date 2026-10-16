/**
 * The identity route that starts a single sign-on. It answers the identity
 * provider URL to send the browser to and sets the cookie that binds the
 * callback to this browser, so it always goes out with credentials.
 */

import apiClient from './client';
import type { SsoStartRead, SsoStartRequest } from '../types/Api';

/** The route a single sign-on is started at. */
export const SSO_START_PATH = '/auth/sso/start';

/**
 * Starts a single sign-on found by email, tenant or connection, answering where
 * the identity provider signs the person in. A 404 `SSO_CONNECTION_NOT_FOUND`
 * means nothing matched.
 */
export const startSsoSignIn = async (
  body: SsoStartRequest
): Promise<SsoStartRead> => {
  const response = await apiClient.post<SsoStartRead>(SSO_START_PATH, body);
  return response.data;
};
