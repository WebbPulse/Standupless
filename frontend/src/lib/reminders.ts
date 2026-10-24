/**
 * The arithmetic behind "Remind me": the presets an issue offers and the custom
 * moment, each worked out on the viewer's own clock. The clock is the timezone
 * stored on their profile, else the browser's, the same zone due dates are
 * judged in, so "tomorrow morning" is nine in the morning where the person is.
 *
 * The server takes any timezone aware moment at least a minute out and within
 * a year, and stores it as given. Everything here is deterministic.
 */

import { weekStartDay } from './preferences';
import { viewerTimezone } from './viewerTimezone';

/** The hour of the day a morning preset lands on, on the viewer's clock. */
export const MORNING_HOUR = 9;

/** The hours "Later today" waits, rounded up to the next whole hour. */
const LATER_HOURS = 3;

/** The furthest out a reminder may be set, matching the server's limit. */
export const REMINDER_MAX_DAYS = 365;

/** The earliest a reminder may come due, matching the server's floor. */
export const REMINDER_MIN_MS = 60 * 1000;

/** A wall clock reading in one timezone. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 for Sunday through 6 for Saturday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A formatter for `zone`, falling back to UTC for a zone the runtime refuses. */
const partsFormatter = (zone: string): Intl.DateTimeFormat => {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
};

/** What the clock on the wall reads in `zone` at `moment`. */
export const wallClockIn = (moment: Date, zone: string): WallClock => {
  const parts = partsFormatter(zone).formatToParts(moment);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    weekday: Math.max(0, WEEKDAYS.indexOf(read('weekday'))),
  };
};

/** The moment a wall clock reading in `zone` stands for. */
export const fromWallClock = (
  clock: Pick<WallClock, 'year' | 'month' | 'day' | 'hour' | 'minute'>,
  zone: string
): Date => {
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute
  );
  const offsetAt = (instant: number): number => {
    const seen = wallClockIn(new Date(instant), zone);
    return (
      Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) -
      instant
    );
  };
  const first = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(first));
};

/** The calendar day `days` after the one `clock` reads, at `hour` sharp. */
const dayAfter = (clock: WallClock, days: number, hour: number): WallClock => {
  const shifted = new Date(
    Date.UTC(clock.year, clock.month - 1, clock.day + days)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour,
    minute: 0,
    weekday: shifted.getUTCDay(),
  };
};

/** One reminder choice: what it reads as and the moment it resolves to. */
export interface ReminderPreset {
  id: string;
  label: string;
  at: Date;
}

/**
 * The presets "Remind me" offers at `now`, in the order the dialog lists them.
 * "Later today" is three hours out, rounded up to the hour, and is left out
 * when that would already be tomorrow. "Next week" is the morning the viewer's
 * week starts, a full week out when today is already that day.
 */
export const reminderPresets = (
  now: Date = new Date(),
  zone: string = viewerTimezone()
): ReminderPreset[] => {
  const today = wallClockIn(now, zone);
  const presets: ReminderPreset[] = [];
  const later = new Date(now.getTime() + LATER_HOURS * 60 * 60 * 1000);
  const laterClock = wallClockIn(later, zone);
  const roundedHour =
    laterClock.minute === 0 ? laterClock.hour : laterClock.hour + 1;
  if (laterClock.day === today.day && roundedHour < 24) {
    presets.push({
      id: 'later',
      label: 'Later today',
      at: fromWallClock({ ...laterClock, hour: roundedHour, minute: 0 }, zone),
    });
  }
  presets.push({
    id: 'tomorrow',
    label: 'Tomorrow morning',
    at: fromWallClock(dayAfter(today, 1, MORNING_HOUR), zone),
  });
  const daysAhead = (weekStartDay() - today.weekday + 7) % 7 || 7;
  presets.push({
    id: 'week',
    label: 'Next week',
    at: fromWallClock(dayAfter(today, daysAhead, MORNING_HOUR), zone),
  });
  return presets;
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** A moment as the `YYYY-MM-DDTHH:mm` a datetime-local input holds, on `zone`'s clock. */
export const toLocalInput = (
  moment: Date,
  zone: string = viewerTimezone()
): string => {
  const clock = wallClockIn(moment, zone);
  return `${String(clock.year)}-${pad(clock.month)}-${pad(clock.day)}T${pad(clock.hour)}:${pad(clock.minute)}`;
};

/** The moment a datetime-local value means on `zone`'s clock, or null for one that does not parse. */
export const fromLocalInput = (
  value: string,
  zone: string = viewerTimezone()
): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return fromWallClock({ year, month, day, hour, minute }, zone);
};

/** How the furthest allowed moment reads in a refusal, "the next year" or "the next 90 days". */
const horizonLabel = (maxDays: number): string =>
  maxDays === REMINDER_MAX_DAYS
    ? 'the next year'
    : `the next ${String(maxDays)} days`;

/**
 * Why a custom moment cannot be used, or null when it can. `maxDays` is the
 * furthest out the server takes, a year for reminders unless a caller such as
 * the inbox snooze passes its own bound.
 */
export const reminderProblem = (
  moment: Date | null,
  now: Date = new Date(),
  maxDays: number = REMINDER_MAX_DAYS
): string | null => {
  if (moment === null || Number.isNaN(moment.getTime())) {
    return 'Pick a date and time.';
  }
  if (moment.getTime() < now.getTime() + REMINDER_MIN_MS) {
    return 'Pick a time in the future.';
  }
  if (moment.getTime() > now.getTime() + maxDays * 24 * 60 * 60 * 1000) {
    return `Pick a time within ${horizonLabel(maxDays)}.`;
  }
  return null;
};

/** A reminder moment as short text on the viewer's clock, such as "Tue, Oct 21, 9:00 AM". */
export const reminderLabel = (
  moment: string | Date,
  zone: string = viewerTimezone()
): string => {
  const date = typeof moment === 'string' ? new Date(moment) : moment;
  if (Number.isNaN(date.getTime())) return '';
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  try {
    return date.toLocaleString(undefined, { ...options, timeZone: zone });
  } catch {
    return date.toLocaleString(undefined, options);
  }
};
