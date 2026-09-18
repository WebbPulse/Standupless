/**
 * Turns a thrown value into the sentence a page shows. The server's own wording
 * is preferred wherever it sent one, because it is the only text that knows why
 * the call was refused.
 */

import {
  ApiError,
  formatApiErrorMessage,
  getWebbPulseError,
} from '@webbpulse/api-client';

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

/** The status the API answers when a body is refused on its own terms. */
export const UNPROCESSABLE = 422;

/**
 * The M3 error codes, rendered as the sentence a person reads. The server's
 * own message is preferred wherever it sent one; these are the wording for the
 * codes whose server message is a contract term rather than a sentence, and
 * they are the only place a code turns into copy.
 */
const M3_CODE_MESSAGES: Record<string, string> = {
  UNSUPPORTED_MEDIA_TYPE:
    'That file type cannot be attached. Images, PDFs, text, CSV, ZIP and Office documents are accepted.',
  UPLOAD_TOO_LARGE: 'That file is above the 25 MB limit.',
  UNKNOWN_UPLOAD:
    'That upload expired before it was saved. Choose the file again.',
  INVALID_FILTER:
    'That view uses a filter this product does not recognise. Remove it and save again.',
  QUERY_TOO_SHORT:
    'Search needs a word of at least four letters. Shorter words are not indexed.',
  CONFLICT: 'That change conflicts with what is already there.',
  FORBIDDEN: 'You are not allowed to change this.',
};

/** The stable `error_code` a failure carried, or null when it carried none. */
export const errorCode = (error: unknown): string | null => {
  if (!(error instanceof ApiError)) return null;
  return getWebbPulseError(error).errorCode ?? null;
};

/**
 * Reads a failure into a sentence, preferring an M3 code's own wording when
 * the code is one whose server message names a contract term rather than
 * saying what a person should do about it.
 */
export const m3ErrorMessage = (error: unknown, fallback: string): string => {
  const code = errorCode(error);
  const known = code === null ? undefined : M3_CODE_MESSAGES[code];
  if (known !== undefined) return known;
  return errorMessage(error, fallback);
};
