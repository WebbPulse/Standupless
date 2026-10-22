/**
 * How `amr` sign-in methods read on the Sessions page and in the audit log.
 */

import { describe, expect, it } from 'vitest';
import { signInMethodLabel, signInMethodLabels } from './amr';

describe('signInMethodLabel', () => {
  it('names a passkey with its PIN', () => {
    expect(signInMethodLabel(['swk', 'pin'])).toBe('Passkey + PIN');
  });

  it('names a password with a second factor', () => {
    expect(signInMethodLabel(['pwd', 'mfa', 'otp'])).toBe(
      'Password + 2FA + Authenticator code'
    );
  });

  it('names a social sign-in by its provider', () => {
    expect(signInMethodLabel(['oauth', 'github'])).toBe('GitHub');
    expect(signInMethodLabel(['oauth', 'google', 'mfa'])).toBe('Google + 2FA');
    expect(signInMethodLabel(['oauth'])).toBe('Connected account');
  });

  it('names each method once', () => {
    expect(signInMethodLabels(['passkey', 'hwk', 'swk'])).toEqual(['Passkey']);
  });

  it('keeps unknown codes as sent', () => {
    expect(signInMethodLabel(['pwd', 'face'])).toBe('Password + face');
  });

  it('reads an empty list as an empty string', () => {
    expect(signInMethodLabel([])).toBe('');
  });
});
