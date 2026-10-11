/**
 * Shared HTTP client for the Standupless API. The access token comes from
 * `AuthClient` and never from `localStorage`, and passing `auth` turns on the
 * shared client's refresh-once-on-401 pipeline. Requests go out through
 * `sharedFetch`, which shares identical reads and waits out rate limits, and
 * a gateway authorizer denial comes back as the 401 it means.
 */

import {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiResponse,
  type RequestOptions,
} from '@webbpulse/api-client';
import { appConfig } from '../config/app';
import { getIdentityClient } from './identityClient';
import { withAuthorizerDenialAsUnauthorized } from './authorizerDenial';
import { sharedFetch } from './sharedFetch';

const identityAuth = getIdentityClient();

/** The one client every API call in this application goes through. */
export const apiClient: ApiClient = createApiClient({
  baseUrl: appConfig.apiBaseUrl,
  credentials: 'include',
  timeoutMs: 30000,
  fetch: withAuthorizerDenialAsUnauthorized(sharedFetch),
  ...(identityAuth !== null ? { auth: identityAuth } : {}),
});

export type { ApiResponse, RequestOptions };

export { clearSharedGetCache } from './sharedFetch';

/** True when the error came back from the API carrying an HTTP status. */
export const isApiErrorWithStatus = (error: unknown): error is ApiError =>
  error instanceof ApiError;

export default apiClient;
