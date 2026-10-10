/**
 * Copy for the passkey answer to the sign-in MFA challenge.
 */

import type { PasskeyMfaOutcome } from '@webbpulse/auth';

/**
 * Why a passkey did not answer the second leg of a sign in, in a sentence
 * that names the way forward. `canUseCode` says whether a TOTP code is offered.
 */
export const describePasskeyMfaFailure = (
  outcome: Exclude<PasskeyMfaOutcome, { ok: true }>,
  canUseCode: boolean
): string => {
  const fallback = canUseCode ? ' or enter a code instead' : '';
  switch (outcome.reason) {
    case 'cancelled':
      return `The passkey prompt was closed. Try again${fallback}.`;
    case 'no-passkeys':
      return canUseCode
        ? 'This account has no passkey. Enter the code from your authenticator app.'
        : 'This account has no passkey. Sign in again another way.';
    case 'ticket-invalid':
      return 'That sign-in attempt has expired. Sign in again.';
    case 'unsupported':
      return `This browser cannot use passkeys. Use another browser${fallback}.`;
    default:
      return outcome.message;
  }
};
