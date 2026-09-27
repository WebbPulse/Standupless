/**
 * The access display helpers. `parseExpiryDays` is the one worth pinning: the
 * number box's own `min` and `max` stop most bad values, but a blank box means
 * a key that never expires rather than a zero, and that distinction is what
 * decides whether `expires_in_days` is sent at all.
 *
 * The live and state helpers are pinned because a revoked or expired key stays
 * in the list, so the label is the only thing telling a person it is dead.
 */

import { describe, expect, it } from 'vitest';
import {
  dateLabel,
  isKeyLive,
  isLinkLive,
  keyStateLabel,
  kindLabel,
  parseExpiryDays,
  targetTypeLabel,
} from './accessDisplay';
import type { ApiKeyRead } from '../types/Api';

const NOW = new Date('2026-09-18T00:00:00Z');

/** One key row, defaulted to a live personal key. */
const key = (over: Partial<ApiKeyRead> = {}): ApiKeyRead => ({
  key_id: 'key-1',
  name: 'Shell',
  kind: 'user',
  prefix: 'wpk_abcd1234',
  scopes: ['issues:read'],
  created_by: 'user-1',
  created_at: '2026-09-01T00:00:00Z',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  ...over,
});

describe('parseExpiryDays', () => {
  it('reads a blank box as a key that never expires', () => {
    expect(parseExpiryDays('')).toEqual({ ok: true, days: undefined });
    expect(parseExpiryDays('   ')).toEqual({ ok: true, days: undefined });
  });

  it('accepts both ends of the range', () => {
    expect(parseExpiryDays('1')).toEqual({ ok: true, days: 1 });
    expect(parseExpiryDays('365')).toEqual({ ok: true, days: 365 });
  });

  it('refuses a value outside the range', () => {
    expect(parseExpiryDays('0').ok).toBe(false);
    expect(parseExpiryDays('366').ok).toBe(false);
    expect(parseExpiryDays('-5').ok).toBe(false);
  });

  it('refuses anything that is not a whole number of days', () => {
    expect(parseExpiryDays('7.5').ok).toBe(false);
    expect(parseExpiryDays('soon').ok).toBe(false);
  });
});

describe('the key state labels', () => {
  it('calls a key with no expiry active', () => {
    expect(isKeyLive(key(), NOW)).toBe(true);
    expect(keyStateLabel(key(), NOW)).toBe('Active');
  });

  it('calls a revoked key revoked rather than expired', () => {
    const revoked = key({
      revoked_at: '2026-09-10T00:00:00Z',
      expires_at: '2026-09-01T00:00:00Z',
    });
    expect(keyStateLabel(revoked, NOW)).toBe('Revoked');
  });

  it('calls a past expiry expired, since the row stays in the list', () => {
    expect(
      keyStateLabel(key({ expires_at: '2026-09-01T00:00:00Z' }), NOW)
    ).toBe('Expired');
  });

  it('calls a future expiry active', () => {
    expect(
      keyStateLabel(key({ expires_at: '2026-10-01T00:00:00Z' }), NOW)
    ).toBe('Active');
  });
});

describe('the share link liveness', () => {
  it('treats no expiry as live', () => {
    expect(isLinkLive(null, NOW)).toBe(true);
  });

  it('treats a past expiry as dead and a future one as live', () => {
    expect(isLinkLive('2026-09-01T00:00:00Z', NOW)).toBe(false);
    expect(isLinkLive('2026-10-01T00:00:00Z', NOW)).toBe(true);
  });
});

describe('the wording helpers', () => {
  it('names the two key kinds', () => {
    expect(kindLabel('user')).toBe('Personal key');
    expect(kindLabel('workspace')).toBe('Workspace key');
  });

  it('names the two share targets', () => {
    expect(targetTypeLabel('issue')).toBe('Issue');
    expect(targetTypeLabel('view')).toBe('View');
  });

  it('renders an absent or unparseable date as a dash', () => {
    expect(dateLabel(null)).toBe('-');
    expect(dateLabel('')).toBe('-');
    expect(dateLabel('not a date')).toBe('-');
  });
});
