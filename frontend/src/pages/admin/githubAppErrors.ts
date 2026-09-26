/**
 * The sentences the GitHub App admin pages show for each refusal. The server
 * masks the message of any 5xx, so the error code is what carries the reason
 * and this is the one place a code turns into copy.
 */

import { errorCode, hasStatus, NOT_FOUND } from '../../lib/errors';

const MESSAGES: Record<string, string> = {
  ALREADY_CONFIGURED:
    'This environment already has a GitHub App. Remove its keys from the app secret before creating another.',
  NOT_CONFIGURED:
    'This environment has no app secret to store the credentials in, so no App can be created here.',
  INVALID_STATE:
    'This link has expired or was already used. Start again from the GitHub App page.',
  INVALID_CODE:
    'GitHub did not send back a usable code. Start again from the GitHub App page.',
  GITHUB_UNAVAILABLE:
    'GitHub did not finish creating the App. Its code works once, so start again from the GitHub App page.',
  STORE_FAILED:
    'GitHub created the App but its credentials could not be stored. Delete that App under the organization settings on GitHub, then start again.',
};

/** Whether a failure is the 404 every admin route answers a non-admin with. */
export const isNotFound = (error: unknown): boolean =>
  hasStatus(error, NOT_FOUND);

/** The sentence for a refusal, or the fallback when the code is unknown. */
export const githubAppErrorMessage = (
  error: unknown,
  fallback: string
): string => {
  const code = errorCode(error);
  return (code !== null && MESSAGES[code]) || fallback;
};
