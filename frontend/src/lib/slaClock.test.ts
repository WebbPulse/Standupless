/**
 * The SLA clock mirrors the server's: calendar time is plain arithmetic and
 * business days skip local weekends, across daylight saving changes. 2026-10-23
 * is a Friday, New York falls back on Sunday 2026-11-01 and Jerusalem springs
 * forward on Friday 2026-03-27.
 */

import { describe, expect, it } from 'vitest';
import { slaAdvance, slaElapsed, slaRetreat } from './slaClock';

const HOUR = 3_600_000;
const at = (text: string): number => Date.parse(text);

describe('calendar time', () => {
  it('is plain arithmetic without a zone', () => {
    const start = at('2026-10-23T12:00:00Z');
    expect(slaAdvance(start, 48 * HOUR, null)).toBe(start + 48 * HOUR);
    expect(slaRetreat(start, 30 * HOUR, undefined)).toBe(start - 30 * HOUR);
    expect(slaElapsed(start, start + 72 * HOUR, null)).toBe(72 * HOUR);
  });

  it('falls back to plain arithmetic for a zone it does not know', () => {
    const start = at('2026-10-23T12:00:00Z');
    expect(slaAdvance(start, 24 * HOUR, 'Not/AZone')).toBe(start + 24 * HOUR);
  });
});

describe('business days', () => {
  it('skips the weekend a deadline crosses', () => {
    const start = at('2026-10-23T12:00:00Z');
    const deadline = slaAdvance(start, 24 * HOUR, 'UTC');
    expect(deadline).toBe(at('2026-10-26T12:00:00Z'));
    expect(slaElapsed(start, deadline, 'UTC')).toBe(24 * HOUR);
    expect(slaRetreat(deadline, 24 * HOUR, 'UTC')).toBe(start);
  });

  it('waits for Monday when a timer starts on a weekend', () => {
    const start = at('2026-10-24T15:00:00Z');
    expect(slaAdvance(start, 4 * HOUR, 'UTC')).toBe(at('2026-10-26T04:00:00Z'));
    expect(slaElapsed(start, at('2026-10-26T06:00:00Z'), 'UTC')).toBe(6 * HOUR);
  });

  it('reads the weekend in the team zone', () => {
    const start = at('2026-10-24T01:00:00Z');
    expect(slaAdvance(start, HOUR, 'America/New_York')).toBe(
      at('2026-10-24T02:00:00Z')
    );
    expect(slaAdvance(start, HOUR, 'UTC')).toBe(at('2026-10-26T01:00:00Z'));
  });

  it('counts nothing over a daylight saving weekend', () => {
    const start = at('2026-10-30T16:00:00Z');
    const deadline = slaAdvance(start, 24 * HOUR, 'America/New_York');
    expect(deadline).toBe(at('2026-11-02T17:00:00Z'));
    expect(slaElapsed(start, deadline, 'America/New_York')).toBe(24 * HOUR);
  });

  it('counts the real hours of a short weekday', () => {
    const friday = at('2026-03-26T22:00:00Z');
    const saturday = at('2026-03-27T21:00:00Z');
    expect(slaElapsed(friday, saturday, 'Asia/Jerusalem')).toBe(23 * HOUR);
    expect(slaAdvance(friday, 24 * HOUR, 'Asia/Jerusalem')).toBe(
      at('2026-03-29T22:00:00Z')
    );
  });

  it('retreats across a weekend back into Friday', () => {
    expect(slaRetreat(at('2026-10-26T06:00:00Z'), 8 * HOUR, 'UTC')).toBe(
      at('2026-10-23T22:00:00Z')
    );
    expect(slaRetreat(at('2026-10-25T09:00:00Z'), 2 * HOUR, 'UTC')).toBe(
      at('2026-10-23T22:00:00Z')
    );
  });

  it('reads time past a deadline as negative', () => {
    expect(
      slaElapsed(at('2026-10-26T12:00:00Z'), at('2026-10-23T12:00:00Z'), 'UTC')
    ).toBe(-24 * HOUR);
  });
});
