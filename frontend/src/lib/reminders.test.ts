/**
 * The "Remind me" arithmetic. Covers that wall clock readings round trip
 * through a zone across a daylight saving change, that the presets land on the
 * viewer's own clock rather than the browser's, that "Later today" drops out
 * late in the evening, that next week from a Monday is a full week out, and
 * that a custom moment in the past or too far out is refused.
 */

import { describe, expect, it } from 'vitest';
import {
  fromLocalInput,
  fromWallClock,
  reminderPresets,
  reminderProblem,
  toLocalInput,
  wallClockIn,
} from './reminders';

const LA = 'America/Los_Angeles';

const preset = (presets: ReturnType<typeof reminderPresets>, id: string) => {
  const found = presets.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no preset ${id}`);
  return found;
};

describe('wall clock conversion', () => {
  it('reads a moment on a zone clock', () => {
    const clock = wallClockIn(new Date('2026-10-21T16:30:00Z'), LA);
    expect(clock).toMatchObject({
      year: 2026,
      month: 10,
      day: 21,
      hour: 9,
      minute: 30,
      weekday: 3,
    });
  });

  it('round trips on both sides of a daylight saving change', () => {
    for (const value of ['2026-10-31T09:00', '2026-11-02T09:00']) {
      const moment = fromLocalInput(value, LA);
      expect(moment).not.toBeNull();
      expect(toLocalInput(moment as Date, LA)).toBe(value);
    }
    expect(
      fromWallClock(
        { year: 2026, month: 11, day: 2, hour: 9, minute: 0 },
        LA
      ).toISOString()
    ).toBe('2026-11-02T17:00:00.000Z');
  });

  it('refuses an input that does not parse', () => {
    expect(fromLocalInput('', LA)).toBeNull();
    expect(fromLocalInput('tomorrow', LA)).toBeNull();
  });
});

describe('reminder presets', () => {
  it('tomorrow is nine in the morning on the viewer clock', () => {
    const presets = reminderPresets(new Date('2026-10-21T16:30:00Z'), LA);
    expect(preset(presets, 'tomorrow').at.toISOString()).toBe(
      '2026-10-22T16:00:00.000Z'
    );
  });

  it('later today is three hours out, rounded up to the hour', () => {
    const presets = reminderPresets(new Date('2026-10-21T16:30:00Z'), LA);
    expect(preset(presets, 'later').at.toISOString()).toBe(
      '2026-10-21T20:00:00.000Z'
    );
  });

  it('leaves out later today late in the evening', () => {
    const presets = reminderPresets(new Date('2026-10-22T05:30:00Z'), LA);
    expect(presets.map((one) => one.id)).toEqual(['tomorrow', 'week']);
  });

  it('next week from a Monday is a full week out', () => {
    const monday = new Date('2026-10-19T16:00:00Z');
    const presets = reminderPresets(monday, LA);
    const week = wallClockIn(preset(presets, 'week').at, LA);
    expect(week).toMatchObject({ month: 10, day: 26, hour: 9, weekday: 1 });
  });

  it('every preset is in the future and passes the checks', () => {
    const now = new Date('2026-10-21T16:30:00Z');
    for (const one of reminderPresets(now, LA)) {
      expect(reminderProblem(one.at, now)).toBeNull();
    }
  });
});

describe('custom moments', () => {
  const now = new Date('2026-10-21T16:30:00Z');

  it('refuses a moment in the past', () => {
    expect(reminderProblem(new Date('2026-10-21T16:00:00Z'), now)).toBe(
      'Pick a time in the future.'
    );
  });

  it('refuses a moment over a year out', () => {
    expect(reminderProblem(new Date('2027-12-01T16:00:00Z'), now)).toBe(
      'Pick a time within the next year.'
    );
  });

  it('refuses a moment past a shorter bound', () => {
    expect(reminderProblem(new Date('2027-02-01T16:00:00Z'), now, 90)).toBe(
      'Pick a time within the next 90 days.'
    );
    expect(
      reminderProblem(new Date('2026-12-01T16:00:00Z'), now, 90)
    ).toBeNull();
  });

  it('refuses a missing moment', () => {
    expect(reminderProblem(null, now)).toBe('Pick a date and time.');
  });
});
