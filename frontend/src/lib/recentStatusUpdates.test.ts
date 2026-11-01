/** The window and wording of the notice that someone just posted an update. */

import { describe, expect, it } from 'vitest';
import {
  RECENT_UPDATE_WINDOW_MS,
  recentUpdateLine,
  recentUpdatesOf,
} from './recentStatusUpdates';

const NOW = Date.parse('2026-11-01T12:00:00Z');

/** An update posted `ms` before now. */
const postedAgo = (ms: number): { created_at: string } => ({
  created_at: new Date(NOW - ms).toISOString(),
});

describe('recentUpdatesOf', () => {
  it('keeps updates inside the window and drops the rest', () => {
    const fresh = postedAgo(60_000);
    const stale = postedAgo(RECENT_UPDATE_WINDOW_MS);
    expect(recentUpdatesOf([fresh, stale], NOW)).toEqual([fresh]);
  });
});

describe('recentUpdateLine', () => {
  it('names the author, the time and the health', () => {
    expect(
      recentUpdateLine(
        'Mo Member',
        { ...postedAgo(120_000), health: 'at_risk' },
        NOW
      )
    ).toBe('Mo Member posted an update 2m ago, health At risk.');
  });
});
