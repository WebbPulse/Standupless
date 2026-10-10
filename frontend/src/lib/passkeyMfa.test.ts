/**
 * The copy shown when a passkey does not answer the sign-in MFA challenge.
 */

import { describe, expect, it } from 'vitest';
import { describePasskeyMfaFailure } from './passkeyMfa';

describe('describePasskeyMfaFailure', () => {
  it('offers the code after a closed prompt only when there is one', () => {
    const outcome = {
      ok: false,
      reason: 'cancelled',
      code: undefined,
      message: 'cancelled',
    } as const;

    expect(describePasskeyMfaFailure(outcome, true)).toBe(
      'The passkey prompt was closed. Try again or enter a code instead.'
    );
    expect(describePasskeyMfaFailure(outcome, false)).toBe(
      'The passkey prompt was closed. Try again.'
    );
  });

  it('sends an expired attempt back to sign in', () => {
    expect(
      describePasskeyMfaFailure(
        {
          ok: false,
          reason: 'ticket-invalid',
          code: undefined,
          message: 'expired',
        },
        true
      )
    ).toBe('That sign-in attempt has expired. Sign in again.');
  });

  it('falls back to the server message', () => {
    expect(
      describePasskeyMfaFailure(
        {
          ok: false,
          reason: 'rejected',
          code: undefined,
          message: 'That passkey was refused.',
        },
        true
      )
    ).toBe('That passkey was refused.');
  });
});
