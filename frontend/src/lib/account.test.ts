/**
 * The account settings wording: usernames the mention parser can read, and
 * how a session's device and sign-in methods read.
 */

import { describe, expect, it } from 'vitest';
import { USERNAME_PATTERN, deviceLabel, methodLabel } from './account';

describe('USERNAME_PATTERN', () => {
  it('accepts a handle the mention parser reads', () => {
    expect(USERNAME_PATTERN.test('ada')).toBe(true);
    expect(USERNAME_PATTERN.test('ada_lovelace-1')).toBe(true);
  });

  it('refuses spaces, a leading symbol and anything over 39 characters', () => {
    expect(USERNAME_PATTERN.test('Ada Lovelace')).toBe(false);
    expect(USERNAME_PATTERN.test('-ada')).toBe(false);
    expect(USERNAME_PATTERN.test('a'.repeat(40))).toBe(false);
  });
});

describe('session labels', () => {
  it('names known devices and falls back for the rest', () => {
    expect(deviceLabel('mobile')).toBe('Mobile');
    expect(deviceLabel('toaster')).toBe('Unknown device');
  });

  it('names each sign-in method once', () => {
    expect(methodLabel(['pwd', 'otp'])).toBe('Password, Authenticator code');
    expect(methodLabel(['passkey', 'hwk'])).toBe('Passkey');
    expect(methodLabel([])).toBe('');
  });
});
