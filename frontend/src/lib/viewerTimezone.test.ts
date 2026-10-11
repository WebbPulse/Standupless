import { afterEach, describe, expect, it } from 'vitest';
import { isPastDue, setViewerTimezone, todayIn } from './viewerTimezone';

const EVENING_IN_LOS_ANGELES = new Date('2026-09-11T02:00:00Z');

describe('viewerTimezone', () => {
  afterEach(() => {
    setViewerTimezone(null);
  });

  it('reads today on the calendar of the zone', () => {
    expect(todayIn('America/Los_Angeles', EVENING_IN_LOS_ANGELES)).toBe(
      '2026-09-10'
    );
    expect(todayIn('Asia/Tokyo', new Date('2026-09-10T16:00:00Z'))).toBe(
      '2026-09-11'
    );
    expect(todayIn('UTC', EVENING_IN_LOS_ANGELES)).toBe('2026-09-11');
  });

  it('falls back to UTC for a zone the runtime refuses', () => {
    expect(todayIn('Mars/Olympus', EVENING_IN_LOS_ANGELES)).toBe('2026-09-11');
  });

  it('judges a due date on the stored zone, as the reminder does', () => {
    setViewerTimezone('America/Los_Angeles');
    expect(isPastDue('2026-09-10', EVENING_IN_LOS_ANGELES)).toBe(false);
    expect(isPastDue('2026-09-10', new Date('2026-09-11T07:30:00Z'))).toBe(
      true
    );

    setViewerTimezone('Asia/Tokyo');
    expect(isPastDue('2026-09-10', new Date('2026-09-10T15:30:00Z'))).toBe(
      true
    );
  });
});
