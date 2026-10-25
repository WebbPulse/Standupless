/**
 * The status rules the client applies between polls: a status stops showing
 * once its end passes, the away note reads its end, and each "Clear after"
 * choice lands on the right moment on the person's own clock.
 */

import { describe, expect, it } from 'vitest';
import type { UserStatusRead } from '../types/Api';
import {
  STATUS_PRESETS,
  awayNote,
  clearAfterMoment,
  isAway,
  statusInForce,
  statusSummary,
  statusUntilLabel,
} from './userStatus';

const NOW = new Date('2026-10-21T15:30:00Z');

/** A status ending at `until`, away unless told otherwise. */
const status = (
  until: string | null,
  overrides: Partial<UserStatusRead> = {}
): UserStatusRead => ({
  emoji: '🌴',
  text: 'On vacation',
  away: true,
  until,
  set_at: '2026-10-20T00:00:00Z',
  ...overrides,
});

describe('statusInForce', () => {
  it('keeps a status with no end or an end still ahead, and drops one whose end has passed', () => {
    expect(statusInForce(status(null), NOW)).not.toBeNull();
    expect(statusInForce(status('2026-10-22T00:00:00Z'), NOW)).not.toBeNull();
    expect(statusInForce(status('2026-10-21T15:30:00Z'), NOW)).toBeNull();
    expect(statusInForce(null, NOW)).toBeNull();
    expect(statusInForce(undefined, NOW)).toBeNull();
  });
});

describe('isAway and statusSummary', () => {
  it('reads away only while in force, and joins the emoji and text', () => {
    expect(isAway(status(null), NOW)).toBe(true);
    expect(isAway(status(null, { away: false }), NOW)).toBe(false);
    expect(isAway(status('2026-10-01T00:00:00Z'), NOW)).toBe(false);
    expect(statusSummary(status(null), NOW)).toBe('🌴 On vacation');
    expect(statusSummary(status(null, { emoji: '' }), NOW)).toBe('On vacation');
    expect(statusSummary(null, NOW)).toBe('');
  });
});

describe('awayNote', () => {
  it('says until when the away status has an end, plain Away when it has none, and nothing when not away', () => {
    expect(awayNote(status(null), NOW, 'UTC')).toBe('Away');
    expect(awayNote(status('2026-10-27T00:00:00Z'), NOW, 'UTC')).toMatch(
      /^Away until .*27/
    );
    expect(awayNote(status(null, { away: false }), NOW, 'UTC')).toBeNull();
  });
});

describe('statusUntilLabel', () => {
  it('shows a midnight end as a day and any other end with its time', () => {
    const day = statusUntilLabel('2026-10-27T00:00:00Z', 'UTC');
    const timed = statusUntilLabel('2026-10-27T15:00:00Z', 'UTC');

    expect(day).toMatch(/27/);
    expect(day).not.toMatch(/:/);
    expect(timed).toMatch(/:/);
  });
});

describe('clearAfterMoment', () => {
  it('adds minutes and hours to now, and stays for never', () => {
    expect(clearAfterMoment('never', NOW, 'UTC')).toBeNull();
    expect(clearAfterMoment('30m', NOW, 'UTC')?.toISOString()).toBe(
      '2026-10-21T16:00:00.000Z'
    );
    expect(clearAfterMoment('4h', NOW, 'UTC')?.toISOString()).toBe(
      '2026-10-21T19:30:00.000Z'
    );
  });

  it('ends today at the coming midnight on the clock of the person', () => {
    expect(clearAfterMoment('today', NOW, 'UTC')?.toISOString()).toBe(
      '2026-10-22T00:00:00.000Z'
    );
    expect(
      clearAfterMoment('today', NOW, 'America/Los_Angeles')?.toISOString()
    ).toBe('2026-10-22T07:00:00.000Z');
  });

  it('ends this week at a midnight within the next seven days', () => {
    const end = clearAfterMoment('week', NOW, 'UTC')?.getTime() ?? 0;

    expect(new Date(end).getUTCHours()).toBe(0);
    expect(end).toBeGreaterThan(NOW.getTime());
    expect(end - NOW.getTime()).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});

describe('STATUS_PRESETS', () => {
  it('offers vacation, sick, focusing and meetings, with the first two away', () => {
    expect(STATUS_PRESETS.map((preset) => preset.text)).toEqual([
      'On vacation',
      'Out sick',
      'Focusing',
      'In meetings',
    ]);
    expect(STATUS_PRESETS.filter((preset) => preset.away)).toHaveLength(2);
  });
});
