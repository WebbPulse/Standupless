/**
 * The typed confirmation rule and the purge date wording the deletion screens share.
 */

import { describe, expect, it } from 'vitest';
import { confirmationMatches, purgeDateLabel } from './deletion';

describe('confirmationMatches', () => {
  it('needs the exact name, ignoring only surrounding space', () => {
    expect(confirmationMatches(' Mine ', 'Mine', false)).toBe(true);
    expect(confirmationMatches('mine', 'Mine', false)).toBe(false);
    expect(confirmationMatches('', '', false)).toBe(false);
  });

  it('ignores case when asked, as for an email address', () => {
    expect(confirmationMatches('ME@example.com', 'me@example.com', true)).toBe(
      true
    );
  });
});

describe('purgeDateLabel', () => {
  it('falls back to a word rather than a broken date', () => {
    expect(purgeDateLabel(null)).toBe('soon');
    expect(purgeDateLabel('not a date')).toBe('soon');
    expect(purgeDateLabel('2026-10-10T12:00:00Z')).toMatch(/2026/);
  });
});
