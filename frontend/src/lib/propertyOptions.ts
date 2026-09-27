/**
 * The orderings, wording and date arithmetic the property pickers share. Kept
 * out of the picker components so those files export only components, and so
 * the date presets can be tested against a fixed day rather than the clock.
 */

import type { StatusCategory, StatusRead } from '../types/Api';

/** The workflow categories in the order a status picker groups them. */
export const STATUS_CATEGORY_ORDER: StatusCategory[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
];

/** How a status category reads as a group heading. */
export const STATUS_CATEGORY_LABELS: Record<StatusCategory, string> = {
  backlog: 'Backlog',
  unstarted: 'Unstarted',
  started: 'Started',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/**
 * Orders statuses by category, then by position, which is the order the
 * workflow runs in and so the order the picker's number keys follow.
 */
export const sortStatuses = (statuses: StatusRead[]): StatusRead[] =>
  [...statuses].sort(
    (left, right) =>
      STATUS_CATEGORY_ORDER.indexOf(left.category) -
        STATUS_CATEGORY_ORDER.indexOf(right.category) ||
      left.position - right.position
  );

/** Formats a local calendar day as the `YYYY-MM-DD` the contract takes. */
export const isoDate = (day: Date): string => {
  const month = String(day.getMonth() + 1).padStart(2, '0');
  const date = String(day.getDate()).padStart(2, '0');
  return `${String(day.getFullYear())}-${month}-${date}`;
};

/**
 * Reads a `YYYY-MM-DD` value as a local calendar day. `new Date(value)` would
 * read it as UTC midnight, which is the previous day west of Greenwich.
 */
export const parseIsoDate = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const day = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return Number.isNaN(day.getTime()) ? null : day;
};

/** A day a number of days after another, on the local calendar. */
const addDays = (day: Date, count: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + count);

/** One quick pick in a date picker. */
export interface DatePreset {
  label: string;
  value: string;
}

/**
 * The quick picks a date picker offers, counted from `today`. The week ends
 * on Friday because that is when work stops, and next week starts on Monday.
 */
export const datePresets = (today: Date): DatePreset[] => {
  const weekday = today.getDay();
  const toFriday = (5 - weekday + 7) % 7;
  const toMonday = (1 - weekday + 7) % 7 || 7;
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return [
    { label: 'Today', value: isoDate(today) },
    { label: 'Tomorrow', value: isoDate(addDays(today, 1)) },
    { label: 'End of this week', value: isoDate(addDays(today, toFriday)) },
    { label: 'Next week', value: isoDate(addDays(today, toMonday)) },
    { label: 'In two weeks', value: isoDate(addDays(today, 14)) },
    { label: 'End of this month', value: isoDate(monthEnd) },
  ];
};

/**
 * How a date reads on a chip: the short month and day, with the year only
 * when it is not this year. An unreadable value is shown as it came.
 */
export const shortDateLabel = (value: string, today = new Date()): string => {
  const day = parseIsoDate(value);
  if (day === null) return value;
  const sameYear = day.getFullYear() === today.getFullYear();
  return day.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

/** Whether a date falls inside an optional inclusive range. */
export const dateInRange = (
  value: string,
  min: string | undefined,
  max: string | undefined
): boolean =>
  (min === undefined || min === '' || value >= min) &&
  (max === undefined || max === '' || value <= max);

/** A palette new labels are coloured from, so a created label is never grey. */
export const LABEL_PALETTE = [
  '#3b82f6',
  '#06b6d4',
  '#10b981',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#a855f7',
  '#64748b',
];

/** Picks a palette colour for a new label from its name, so it is stable. */
export const labelColorFor = (name: string): string => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length] ?? '#64748b';
};
