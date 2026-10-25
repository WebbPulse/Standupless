/**
 * How long an issue has sat in its current status, read from the
 * `status_changed_at` stamp the server keeps: a compact duration ("3d", "5w")
 * for dense rows and cards, and words ("for 3 days") for the hover card and
 * the peek, with the exact moment left to a tooltip.
 */

import type { IssueRead } from '../types/Api';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

/** When the issue entered its status, falling back to its creation for a row read without the stamp. */
export const enteredStatusAt = (
  issue: Pick<IssueRead, 'created_at' | 'status_changed_at'>
): string => issue.status_changed_at ?? issue.created_at;

/** The whole units elapsed between `value` and `now`, the largest unit that fits, or null when it does not parse. */
const elapsedUnits = (
  value: string,
  now: Date
): {
  count: number;
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
} | null => {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  const elapsed = Math.max(0, now.getTime() - time);
  if (elapsed < HOUR_MS)
    return { count: Math.floor(elapsed / MINUTE_MS), unit: 'minute' };
  if (elapsed < DAY_MS)
    return { count: Math.floor(elapsed / HOUR_MS), unit: 'hour' };
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 2 * WEEK_DAYS) return { count: days, unit: 'day' };
  if (days < 3 * MONTH_DAYS)
    return { count: Math.floor(days / WEEK_DAYS), unit: 'week' };
  if (days < YEAR_DAYS)
    return { count: Math.floor(days / MONTH_DAYS), unit: 'month' };
  return { count: Math.floor(days / YEAR_DAYS), unit: 'year' };
};

const COMPACT_SUFFIX = {
  minute: 'm',
  hour: 'h',
  day: 'd',
  week: 'w',
  month: 'mo',
  year: 'y',
} as const;

/**
 * The time since `value` in the fewest characters: "now", "5m", "3h", "9d",
 * "5w", "4mo" or "2y". Days run to two weeks and weeks to three months, so a
 * stuck issue reads in the unit a standup talks in. A value that does not
 * parse is returned as it came.
 */
export const compactDuration = (
  value: string,
  now: Date = new Date()
): string => {
  const units = elapsedUnits(value, now);
  if (units === null) return value;
  if (units.unit === 'minute' && units.count < 1) return 'now';
  return `${String(units.count)}${COMPACT_SUFFIX[units.unit]}`;
};

/** The time since `value` in words, "less than a minute", "1 hour" or "3 days". */
export const durationWords = (
  value: string,
  now: Date = new Date()
): string => {
  const units = elapsedUnits(value, now);
  if (units === null) return value;
  if (units.unit === 'minute' && units.count < 1) return 'less than a minute';
  return `${String(units.count)} ${units.unit}${units.count === 1 ? '' : 's'}`;
};

/** "In Todo for 3 days", the sentence the hover card and the peek show. */
export const timeInStatusSentence = (
  statusName: string,
  issue: Pick<IssueRead, 'created_at' | 'status_changed_at'>,
  now: Date = new Date()
): string =>
  `In ${statusName} for ${durationWords(enteredStatusAt(issue), now)}`;
