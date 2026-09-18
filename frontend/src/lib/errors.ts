/**
 * Turns a thrown value into the sentence a page shows. The server's own wording
 * is preferred wherever it sent one, because it is the only text that knows why
 * the call was refused.
 */

import { ApiError, formatApiErrorMessage } from '@webbpulse/api-client';

/** The status the API answers when a workspace is invisible to the caller. */
export const NOT_FOUND = 404;

/** The status the API answers when a delete would leave a category empty. */
export const CONFLICT = 409;

/**
 * Reads a failure into a sentence, falling back to the caller's wording when
 * the failure carried none of its own.
 */
export const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) {
    return formatApiErrorMessage(error.body, fallback);
  }
  return fallback;
};

/** Whether a failure came back carrying this HTTP status. */
export const hasStatus = (error: unknown, status: number): boolean =>
  error instanceof ApiError && error.status === status;
