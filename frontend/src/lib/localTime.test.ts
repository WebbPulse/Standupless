/**
 * A member's local time reads as their clock and its distance from the
 * viewer's, in whole hours or hours and minutes, and an unknown or empty zone
 * reads as nothing.
 */

import { describe, expect, it } from 'vitest';
import { localTimeIn, offsetLabel, zoneOffsetMinutes } from './localTime';

const NOW = new Date('2026-10-24T12:00:00Z');

describe('zoneOffsetMinutes', () => {
  it('reads a zone offset from UTC', () => {
    expect(zoneOffsetMinutes('UTC', NOW)).toBe(0);
    expect(zoneOffsetMinutes('Asia/Tokyo', NOW)).toBe(540);
    expect(zoneOffsetMinutes('Asia/Kolkata', NOW)).toBe(330);
    expect(zoneOffsetMinutes('America/Los_Angeles', NOW)).toBe(-420);
  });

  it('refuses a zone the runtime does not know', () => {
    expect(zoneOffsetMinutes('Mars/Olympus_Mons', NOW)).toBeNull();
  });
});

describe('offsetLabel', () => {
  it('says how the clocks differ', () => {
    expect(offsetLabel(0)).toBe('same time as you');
    expect(offsetLabel(300)).toBe('5h ahead');
    expect(offsetLabel(-420)).toBe('7h behind');
    expect(offsetLabel(330)).toBe('5h 30m ahead');
    expect(offsetLabel(-30)).toBe('30m behind');
  });
});

describe('localTimeIn', () => {
  it('formats the member clock and its distance from the viewer', () => {
    const local = localTimeIn('Asia/Tokyo', NOW, 'America/New_York');

    expect(local?.time).toMatch(/9:00/);
    expect(local?.offset).toBe('13h ahead');
  });

  it('counts half hour zones', () => {
    expect(localTimeIn('Asia/Kolkata', NOW, 'UTC')?.offset).toBe(
      '5h 30m ahead'
    );
  });

  it('says when the member shares the viewer clock', () => {
    expect(localTimeIn('Europe/London', NOW, 'Europe/London')?.offset).toBe(
      'same time as you'
    );
  });

  it('reads nothing for a missing or unknown zone', () => {
    expect(localTimeIn(null, NOW, 'UTC')).toBeNull();
    expect(localTimeIn(undefined, NOW, 'UTC')).toBeNull();
    expect(localTimeIn('', NOW, 'UTC')).toBeNull();
    expect(localTimeIn('Mars/Olympus_Mons', NOW, 'UTC')).toBeNull();
    expect(localTimeIn('Asia/Tokyo', NOW, 'Mars/Olympus_Mons')).toBeNull();
  });
});
