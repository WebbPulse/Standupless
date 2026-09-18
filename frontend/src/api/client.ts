/**
 * Shared HTTP client for the Standupless API. The access token comes from
 * `AuthClient` and never from `localStorage`, and passing `auth` turns on the
 * shared client's refresh-once-on-401 pipeline.
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

const identityAuth = getIdentityClient();

/** The one client every call site in this application goes through. */
export const apiClient: ApiClient = createApiClient({
  baseUrl: appConfig.apiBaseUrl,
  credentials: 'include',
  timeoutMs: 30000,
  ...(identityAuth !== null ? { auth: identityAuth } : {}),
});

export type { ApiResponse, RequestOptions };

/** True when the error came back from the API carrying an HTTP status. */
export const isApiErrorWithStatus = (error: unknown): error is ApiError =>
  error instanceof ApiError;

export default apiClient;
