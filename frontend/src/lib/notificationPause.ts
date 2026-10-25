/**
 * Pausing notifications and working hours, worked out on the person's own
 * clock. The presets "Pause notifications" offers land where the person is,
 * and `notificationsHeld` mirrors the server's rule so the sidebar indicator
 * and desktop notifications agree with what email does. While held, email and
 * desktop notifications wait and the inbox still fills.
 */

import type { UserRead, WorkingHours, WorkingDay } from '../types/Api';
import { weekStartDay } from './preferences';
import { fromWallClock, wallClockIn, type WallClock } from './reminders';
import { viewerTimezone } from './viewerTimezone';

/** The longest pause the server takes, in days. */
export const PAUSE_MAX_DAYS = 30;

/** Every day a schedule may name, Monday first, as the server orders them. */
export const WORKING_DAYS: WorkingDay[] = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

/** How each day reads in the schedule picker. */
export const WORKING_DAY_LABELS: Record<WorkingDay, string> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
};

/** The schedule a person starts from when they first turn working hours on. */
export const DEFAULT_WORKING_HOURS: WorkingHours = {
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '09:00',
  end: '17:00',
};

/** A `WallClock` weekday, 0 for Sunday, as a schedule day. */
const dayOf = (weekday: number): WorkingDay =>
  WORKING_DAYS[(weekday + 6) % 7] ?? 'mon';

/** An `HH:MM` value as minutes since midnight, or null for one that does not parse. */
export const clockMinutes = (value: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/** Why a schedule cannot be saved, or null when it can. */
export const workingHoursProblem = (hours: WorkingHours): string | null => {
  if (hours.days.length === 0) return 'Pick at least one day.';
  const start = clockMinutes(hours.start);
  const end = clockMinutes(hours.end);
  if (start === null || end === null) return 'Pick a start and end time.';
  if (end <= start) return 'Working hours must end after they start.';
  return null;
};

/** The calendar day `days` after `clock`, at `minutes` past midnight. */
const dayAfter = (clock: WallClock, days: number, minutes: number) => {
  const shifted = new Date(
    Date.UTC(clock.year, clock.month - 1, clock.day + days)
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    weekday: shifted.getUTCDay(),
  };
};

/**
 * `moment` when it falls inside the working hours, else the moment they next
 * begin, each day's bounds read on `zone`'s wall clock.
 */
export const nextWorkingMoment = (
  hours: WorkingHours,
  zone: string,
  moment: Date
): Date => {
  const start = clockMinutes(hours.start);
  const end = clockMinutes(hours.end);
  if (start === null || end === null || hours.days.length === 0) return moment;
  const today = wallClockIn(moment, zone);
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = dayAfter(today, offset, 0);
    if (!hours.days.includes(dayOf(day.weekday))) continue;
    const opens = fromWallClock(dayAfter(today, offset, start), zone);
    const closes = fromWallClock(dayAfter(today, offset, end), zone);
    if (moment.getTime() < opens.getTime()) return opens;
    if (moment.getTime() < closes.getTime()) return moment;
  }
  return moment;
};

/** The end of a pause that is still running, or null when none is. */
export const pausedUntil = (
  user: Pick<UserRead, 'notifications_paused_until'> | null | undefined,
  now: Date = new Date()
): Date | null => {
  const raw = user?.notifications_paused_until;
  if (!raw) return null;
  const until = new Date(raw);
  if (Number.isNaN(until.getTime())) return null;
  return until.getTime() > now.getTime() ? until : null;
};

/**
 * The moment this person's notifications may reach them again, or null when
 * they may now. A running pause moves it to the pause's end, and working hours
 * then move it on to the next time they begin.
 */
export const notificationsHeldUntil = (
  user:
    | Pick<
        UserRead,
        'notifications_paused_until' | 'working_hours' | 'timezone'
      >
    | null
    | undefined,
  now: Date = new Date()
): Date | null => {
  if (!user) return null;
  let release = pausedUntil(user, now) ?? now;
  if (user.working_hours) {
    release = nextWorkingMoment(
      user.working_hours,
      user.timezone ?? viewerTimezone(),
      release
    );
  }
  return release.getTime() > now.getTime() ? release : null;
};

/**
 * Whether one desktop notification of `kind` should show now. Held people see
 * nothing, unless they let urgent ones through and this is a direct mention.
 * The desktop path has no priority to read, so an urgent assignment waits.
 */
export const desktopNotificationAllowed = (
  user:
    | Pick<
        UserRead,
        | 'notifications_paused_until'
        | 'working_hours'
        | 'timezone'
        | 'urgent_bypasses_pause'
      >
    | null
    | undefined,
  kind: string,
  now: Date = new Date()
): boolean => {
  if (notificationsHeldUntil(user, now) === null) return true;
  return Boolean(user?.urgent_bypasses_pause) && kind === 'mentioned';
};

/** One pause choice: what it reads as and the moment it runs until. */
export interface PausePreset {
  id: 'hour' | 'tomorrow' | 'week';
  label: string;
  until: Date;
}

/**
 * The presets "Pause notifications" offers at `now`, in the order the menu
 * lists them, as in Linear: an hour, tomorrow morning and next week. A morning
 * is the start of the person's working hours when they set them, else nine.
 * "Next week" is the morning the person's week starts.
 */
export const pausePresets = (
  hours: WorkingHours | null | undefined,
  now: Date = new Date(),
  zone: string = viewerTimezone()
): PausePreset[] => {
  const today = wallClockIn(now, zone);
  const morning = (hours && clockMinutes(hours.start)) ?? 9 * 60;
  const daysAhead = (weekStartDay() - today.weekday + 7) % 7 || 7;
  return [
    {
      id: 'hour',
      label: 'For 1 hour',
      until: new Date(now.getTime() + 60 * 60 * 1000),
    },
    {
      id: 'tomorrow',
      label: 'Until tomorrow morning',
      until: fromWallClock(dayAfter(today, 1, morning), zone),
    },
    {
      id: 'week',
      label: 'Until next week',
      until: fromWallClock(dayAfter(today, daysAhead, morning), zone),
    },
  ];
};
