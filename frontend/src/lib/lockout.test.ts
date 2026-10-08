/**
 * Reading a second-factor lockout off a step-up refusal, and its wording.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_FALLBACK_SECONDS,
  lockedUntilFrom,
  lockoutMessage,
} from './lockout';

describe('lockedUntilFrom', () => {
  it('ends the lockout after the wait the refusal names', () => {
    expect(
      lockedUntilFrom(
        { ok: false, reason: 'rate-limited', retryAfter: 300 },
        1000
      )
    ).toBe(301000);
  });

  it('assumes a short wait when the refusal names none', () => {
    expect(
      lockedUntilFrom({ reason: 'rate-limited', retryAfter: undefined }, 0)
    ).toBe(LOCKOUT_FALLBACK_SECONDS * 1000);
  });

  it('ignores every other refusal', () => {
    expect(lockedUntilFrom({ reason: 'invalid-code' })).toBeNull();
    expect(lockedUntilFrom(new Error('boom'))).toBeNull();
    expect(lockedUntilFrom(null)).toBeNull();
  });
});

describe('lockoutMessage', () => {
  it('rounds the wait up to whole minutes', () => {
    expect(lockoutMessage(300000)).toBe(
      'Too many attempts, try again in 5 minutes.'
    );
    expect(lockoutMessage(61000)).toBe(
      'Too many attempts, try again in 2 minutes.'
    );
  });

  it('never says less than a minute', () => {
    expect(lockoutMessage(5000)).toBe(
      'Too many attempts, try again in 1 minute.'
    );
  });
});
