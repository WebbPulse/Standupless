/**
 * Turns a thrown value into the sentence a page shows. The server's own wording
 * is preferred wherever it sent one, because it is the only text that knows why
 * the call was refused.
 */

import {
  ApiError,
  formatApiErrorMessage,
  getErrorCode,
} from '@webbpulse/api-client';

/** The status the API answers when a workspace is invisible to the caller. */
export const NOT_FOUND = 404;

/** The status the API answers when a delete would leave a category empty. */
export const CONFLICT = 409;

/** The code every create route answers when the workspace plan is full. */
export const PLAN_LIMIT_REACHED = 'PLAN_LIMIT_REACHED';

/**
 * The wording for a plan limit refusal that arrived without its own sentence.
 * The server's message names the resource and the number, so it wins whenever
 * one was sent.
 */
const PLAN_LIMIT_MESSAGE =
  'This workspace has reached its plan limit. Remove one to make room.';

/** Whether a failure was a create refused because the workspace plan is full. */
export const isPlanLimit = (error: unknown): boolean =>
  getErrorCode(error) === PLAN_LIMIT_REACHED;

/** The code a write answers when the workspace plan leaves out the feature. */
export const PLAN_FEATURE_UNAVAILABLE = 'PLAN_FEATURE_UNAVAILABLE';

/** Whether a failure was a write refused because the plan lacks the feature. */
export const isPlanFeatureUnavailable = (error: unknown): boolean =>
  getErrorCode(error) === PLAN_FEATURE_UNAVAILABLE;

/** A plan name as a person reads it, such as `Business` for `business`. */
const planTitle = (plan: string): string =>
  plan.charAt(0).toUpperCase() + plan.slice(1);

/**
 * The wording for a plan feature refusal that arrived without its own
 * sentence. It names the plan to move to when the refusal carried one, and
 * never suggests the caller lacks permission, because the plan is the cause.
 */
const planFeatureMessage = (body: unknown): string => {
  const details =
    typeof body === 'object' && body !== null && 'details' in body
      ? (body as { details?: unknown }).details
      : undefined;
  const required =
    typeof details === 'object' && details !== null
      ? (details as { required_plan?: unknown }).required_plan
      : undefined;
  if (typeof required === 'string' && required.length > 0) {
    return `This feature needs the ${planTitle(required)} plan. Upgrade the workspace on the billing page to use it.`;
  }
  return 'This feature is not included in the workspace plan. Upgrade the workspace on the billing page to use it.';
};

/**
 * Reads a failure into a sentence, falling back to the caller's wording when
 * the failure carried none of its own.
 */
export const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ApiError) {
    if (isPlanLimit(error)) {
      return formatApiErrorMessage(error.body, PLAN_LIMIT_MESSAGE);
    }
    if (isPlanFeatureUnavailable(error)) {
      return formatApiErrorMessage(error.body, planFeatureMessage(error.body));
    }
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
    'That file type cannot be attached. Images, MP4, WebM and MOV videos, PDFs, text, CSV, ZIP and Office documents are accepted.',
  UPLOAD_TOO_LARGE:
    'That file is above the size limit: 25 MB for a file, 200 MB for a video.',
  UNKNOWN_UPLOAD:
    'That upload expired before it was saved. Choose the file again.',
  INVALID_FILTER:
    'That view uses a filter this product does not recognise. Remove it and save again.',
  QUERY_TOO_SHORT:
    'That search only has very common words. Add a more specific one.',
  CONFLICT: 'That change conflicts with what is already there.',
  FORBIDDEN: 'You are not allowed to change this.',
};

/** The stable `error_code` a failure carried, or null when it carried none. */
export const errorCode = (error: unknown): string | null =>
  getErrorCode(error) ?? null;

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
