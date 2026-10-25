/**
 * A member's status, as Linear has it: an emoji, a line of text, an away flag
 * and an optional moment it clears itself. The server stops answering a status
 * once its end passes, and `statusInForce` applies the same rule between polls
 * so a status never outlives its end on screen. The presets and the "Clear
 * after" choices are worked out on the person's own clock.
 */

import type { UserStatusRead } from '../types/Api';
import { weekStartDay } from './preferences';
import { fromWallClock, reminderLabel, wallClockIn } from './reminders';
import { viewerTimezone } from './viewerTimezone';

/** The most characters a status's text holds, matching the server. */
export const STATUS_TEXT_MAX = 80;

/** When a status clears itself. */
export type ClearAfter = 'never' | '30m' | '1h' | '4h' | 'today' | 'week';

/** How each "Clear after" choice reads, in the order the dialog lists them. */
export const CLEAR_AFTER_LABELS: Record<ClearAfter, string> = {
  never: "Don't clear",
  '30m': '30 minutes',
  '1h': '1 hour',
  '4h': '4 hours',
  today: 'Today',
  week: 'This week',
};

/** One ready made status. */
export interface StatusPreset {
  id: 'vacation' | 'sick' | 'focusing' | 'meetings';
  emoji: string;
  text: string;
  away: boolean;
  clearAfter: ClearAfter;
}

/** The presets the status dialog offers. */
export const STATUS_PRESETS: readonly StatusPreset[] = [
  {
    id: 'vacation',
    emoji: '🌴',
    text: 'On vacation',
    away: true,
    clearAfter: 'week',
  },
  {
    id: 'sick',
    emoji: '🤒',
    text: 'Out sick',
    away: true,
    clearAfter: 'today',
  },
  {
    id: 'focusing',
    emoji: '🎯',
    text: 'Focusing',
    away: false,
    clearAfter: '4h',
  },
  {
    id: 'meetings',
    emoji: '📅',
    text: 'In meetings',
    away: false,
    clearAfter: '1h',
  },
];

/** Midnight `days` after `now`'s calendar day on `zone`'s clock. */
const midnightAfter = (now: Date, days: number, zone: string): Date => {
  const today = wallClockIn(now, zone);
  const shifted = new Date(
    Date.UTC(today.year, today.month - 1, today.day + days)
  );
  return fromWallClock(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: 0,
      minute: 0,
    },
    zone
  );
};

/** The moment a "Clear after" choice ends a status set at `now`, or null for one that stays. */
export const clearAfterMoment = (
  choice: ClearAfter,
  now: Date = new Date(),
  zone: string = viewerTimezone()
): Date | null => {
  const minutes = (count: number): Date =>
    new Date(now.getTime() + count * 60 * 1000);
  switch (choice) {
    case 'never':
      return null;
    case '30m':
      return minutes(30);
    case '1h':
      return minutes(60);
    case '4h':
      return minutes(240);
    case 'today':
      return midnightAfter(now, 1, zone);
    case 'week': {
      const weekday = wallClockIn(now, zone).weekday;
      return midnightAfter(now, (weekStartDay() - weekday + 7) % 7 || 7, zone);
    }
  }
};

/** The status while it is in force at `now`, or null once it has ended or when there is none. */
export const statusInForce = (
  status: UserStatusRead | null | undefined,
  now: Date = new Date()
): UserStatusRead | null => {
  if (!status) return null;
  if (!status.until) return status;
  const until = new Date(status.until);
  if (Number.isNaN(until.getTime())) return status;
  return until.getTime() > now.getTime() ? status : null;
};

/** Whether the person is marked away right now. */
export const isAway = (
  status: UserStatusRead | null | undefined,
  now: Date = new Date()
): boolean => statusInForce(status, now)?.away === true;

/** The status as one short line, its emoji then its text, or an empty string for none. */
export const statusSummary = (
  status: UserStatusRead | null | undefined,
  now: Date = new Date()
): string => {
  const shown = statusInForce(status, now);
  if (shown === null) return '';
  return [shown.emoji, shown.text].filter(Boolean).join(' ');
};

/** When a status ends, as short text such as "Mon, Oct 27" or "Tue, Oct 21, 3:00 PM". */
export const statusUntilLabel = (
  until: string,
  zone: string = viewerTimezone()
): string => {
  const moment = new Date(until);
  if (Number.isNaN(moment.getTime())) return '';
  const clock = wallClockIn(moment, zone);
  if (clock.hour !== 0 || clock.minute !== 0)
    return reminderLabel(moment, zone);
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };
  try {
    return moment.toLocaleDateString(undefined, { ...options, timeZone: zone });
  } catch {
    return moment.toLocaleDateString(undefined, options);
  }
};

/**
 * The note an away person carries beside an assignment, "Away until Mon, Oct
 * 27" or plain "Away", or null when they are not away.
 */
export const awayNote = (
  status: UserStatusRead | null | undefined,
  now: Date = new Date(),
  zone: string = viewerTimezone()
): string | null => {
  const shown = statusInForce(status, now);
  if (shown?.away !== true) return null;
  return shown.until
    ? `Away until ${statusUntilLabel(shown.until, zone)}`
    : 'Away';
};
