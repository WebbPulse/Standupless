/**
 * Pausing notifications and working hours on the person's own clock: when a
 * pause is running, when working hours hold, which desktop notifications get
 * through a hold, and where the pause presets land.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WORKING_HOURS,
  clockMinutes,
  desktopNotificationAllowed,
  nextWorkingMoment,
  notificationsHeldUntil,
  pausePresets,
  pausedUntil,
  workingHoursProblem,
} from './notificationPause';

vi.mock('./preferences', () => ({
  weekStartDay: () => 1,
}));

const MONDAY_NOON = new Date('2026-10-26T12:00:00Z');
const WEDNESDAY_NOON = new Date('2026-10-28T12:00:00Z');
const HOUR = 60 * 60 * 1000;

describe('clockMinutes', () => {
  it('reads HH:MM and refuses anything else', () => {
    expect(clockMinutes('09:30')).toBe(570);
    expect(clockMinutes('24:00')).toBeNull();
    expect(clockMinutes('9:30')).toBeNull();
  });
});

describe('workingHoursProblem', () => {
  it('accepts the default and names what is wrong otherwise', () => {
    expect(workingHoursProblem(DEFAULT_WORKING_HOURS)).toBeNull();
    expect(workingHoursProblem({ ...DEFAULT_WORKING_HOURS, days: [] })).toMatch(
      /at least one day/
    );
    expect(
      workingHoursProblem({
        ...DEFAULT_WORKING_HOURS,
        start: '17:00',
        end: '09:00',
      })
    ).toMatch(/end after/);
  });
});

describe('pausedUntil', () => {
  it('answers a running pause and ignores a past or missing one', () => {
    const later = new Date(MONDAY_NOON.getTime() + HOUR);
    expect(
      pausedUntil(
        { notifications_paused_until: later.toISOString() },
        MONDAY_NOON
      )
    ).toEqual(later);
    expect(
      pausedUntil(
        { notifications_paused_until: '2026-10-26T11:00:00Z' },
        MONDAY_NOON
      )
    ).toBeNull();
    expect(
      pausedUntil({ notifications_paused_until: null }, MONDAY_NOON)
    ).toBeNull();
    expect(pausedUntil(null, MONDAY_NOON)).toBeNull();
  });
});

describe('nextWorkingMoment', () => {
  it('keeps a moment inside the hours and moves one outside to the next start', () => {
    expect(
      nextWorkingMoment(DEFAULT_WORKING_HOURS, 'UTC', MONDAY_NOON)
    ).toEqual(MONDAY_NOON);
    expect(
      nextWorkingMoment(
        DEFAULT_WORKING_HOURS,
        'UTC',
        new Date('2026-10-26T18:00:00Z')
      )
    ).toEqual(new Date('2026-10-27T09:00:00Z'));
    expect(
      nextWorkingMoment(
        DEFAULT_WORKING_HOURS,
        'UTC',
        new Date('2026-10-24T10:00:00Z')
      )
    ).toEqual(new Date('2026-10-26T09:00:00Z'));
  });

  it('reads the hours on the zone wall clock', () => {
    expect(
      nextWorkingMoment(
        { days: ['mon'], start: '09:00', end: '17:00' },
        'America/New_York',
        MONDAY_NOON
      )
    ).toEqual(new Date('2026-10-26T13:00:00Z'));
  });
});

describe('notificationsHeldUntil', () => {
  it('holds nobody without a pause or working hours', () => {
    expect(
      notificationsHeldUntil(
        {
          notifications_paused_until: null,
          working_hours: null,
          timezone: 'UTC',
        },
        MONDAY_NOON
      )
    ).toBeNull();
  });

  it('combines a pause with working hours, the later winning', () => {
    expect(
      notificationsHeldUntil(
        {
          notifications_paused_until: '2026-10-26T20:00:00Z',
          working_hours: DEFAULT_WORKING_HOURS,
          timezone: 'UTC',
        },
        MONDAY_NOON
      )
    ).toEqual(new Date('2026-10-27T09:00:00Z'));
  });
});

describe('desktopNotificationAllowed', () => {
  const paused = {
    notifications_paused_until: '2026-10-26T13:00:00Z',
    working_hours: null,
    timezone: 'UTC',
  };

  it('shows everything when nothing holds', () => {
    expect(desktopNotificationAllowed(null, 'commented', MONDAY_NOON)).toBe(
      true
    );
  });

  it('holds everything while paused unless a mention may break through', () => {
    expect(desktopNotificationAllowed(paused, 'mentioned', MONDAY_NOON)).toBe(
      false
    );
    const bypass = { ...paused, urgent_bypasses_pause: true };
    expect(desktopNotificationAllowed(bypass, 'mentioned', MONDAY_NOON)).toBe(
      true
    );
    expect(desktopNotificationAllowed(bypass, 'assigned', MONDAY_NOON)).toBe(
      false
    );
  });
});

describe('pausePresets', () => {
  it('offers an hour, tomorrow morning and the start of next week', () => {
    const presets = pausePresets(null, WEDNESDAY_NOON, 'UTC');
    expect(presets.map((preset) => preset.id)).toEqual([
      'hour',
      'tomorrow',
      'week',
    ]);
    expect(presets[0]?.until).toEqual(new Date('2026-10-28T13:00:00Z'));
    expect(presets[1]?.until).toEqual(new Date('2026-10-29T09:00:00Z'));
    expect(presets[2]?.until).toEqual(new Date('2026-11-02T09:00:00Z'));
  });

  it('uses the working start as the morning', () => {
    const presets = pausePresets(
      { ...DEFAULT_WORKING_HOURS, start: '08:30' },
      WEDNESDAY_NOON,
      'UTC'
    );
    expect(presets[1]?.until).toEqual(new Date('2026-10-29T08:30:00Z'));
  });

  it('moves a full week ahead when today is the first day of the week', () => {
    const presets = pausePresets(null, MONDAY_NOON, 'UTC');
    expect(presets[2]?.until).toEqual(new Date('2026-11-02T09:00:00Z'));
  });
});
