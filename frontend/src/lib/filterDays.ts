/**
 * The days a list filter's date bound holds. A bound is either an absolute
 * `YYYY-MM-DD` day, which a custom date stores, or an offset relative to today
 * such as `-2w` or `+7d`, which every preset stores, so a saved view called
 * "Created this fortnight" keeps rolling instead of freezing to the day it was
 * picked. The backend resolves an offset against the request day by calendar,
 * and these helpers resolve it the same way for the picker's preview. The
 * issue filter bar and the projects filter menu share them so a bound reads
 * the same on both lists.
 */

/** A day as `YYYY-MM-DD` in local time, the way a date input reads it. */
export const isoDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
};

/** The day `days` from today, negative for the past. */
export const dayFromToday = (
  days: number,
  today: Date = new Date()
): string => {
  const date = new Date(today);
  date.setDate(date.getDate() + days);
  return isoDay(date);
};

/**
 * Today's UTC calendar day as a local midnight, the day the backend resolves
 * a relative bound against, so a list's own matching agrees with the server's.
 */
export const utcToday = (now: Date = new Date()): Date =>
  new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** An absolute bound, `YYYY-MM-DD`. */
export const ABSOLUTE_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A relative bound: `today`, or a signed count of days, weeks, months or years. */
export const RELATIVE_DAY = /^(?:today|([+-])(\d{1,4})([dwmy]))$/;

/** The unit names a relative bound's letter reads as. */
const UNIT_NAMES: Record<string, string> = {
  d: 'day',
  w: 'week',
  m: 'month',
  y: 'year',
};

/** A relative bound read apart, `null` for anything else. `today` has an amount of zero. */
export const parseRelativeDay = (
  value: string
): { amount: number; unit: 'd' | 'w' | 'm' | 'y' } | null => {
  const match = RELATIVE_DAY.exec(value.trim().toLowerCase());
  if (match === null) return null;
  const [, sign, count, unit] = match;
  if (sign === undefined || count === undefined || unit === undefined) {
    return { amount: 0, unit: 'd' };
  }
  const amount = Number(count) * (sign === '-' ? -1 : 1);
  return { amount, unit: unit as 'd' | 'w' | 'm' | 'y' };
};

/** Whether a bound is written relative to today. */
export const isRelativeDay = (value: string): boolean =>
  parseRelativeDay(value) !== null;

/** Whether a bound is one a date filter can hold: a day, or an offset relative to today. */
export const isDayBound = (value: string): boolean =>
  ABSOLUTE_DAY.test(value) || isRelativeDay(value);

/** `date` moved by whole months, clamped to the last day of the month it lands in. */
const addMonths = (date: Date, months: number): Date => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(
    target.getFullYear(),
    target.getMonth() + 1,
    0
  ).getDate();
  target.setDate(Math.min(date.getDate(), last));
  return target;
};

/**
 * The day a bound means on `today`: an offset resolved by calendar, the way
 * the backend resolves it, and an absolute day returned as it is.
 */
export const resolveDayBound = (
  value: string,
  today: Date = new Date()
): string => {
  const relative = parseRelativeDay(value);
  if (relative === null) return value;
  const { amount, unit } = relative;
  if (unit === 'd') return dayFromToday(amount, today);
  if (unit === 'w') return dayFromToday(amount * 7, today);
  return isoDay(addMonths(today, unit === 'm' ? amount : amount * 12));
};

/** A relative bound's size in words, such as "2 weeks", ignoring its sign. */
export const offsetText = (value: string): string => {
  const relative = parseRelativeDay(value);
  if (relative === null || relative.amount === 0) return 'today';
  const count = Math.abs(relative.amount);
  const unit = UNIT_NAMES[relative.unit] ?? 'day';
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
};

/** How a relative bound reads on its own: "Today", "2 weeks ago" or "In 1 week". */
export const relativeDayLabel = (value: string): string => {
  const relative = parseRelativeDay(value);
  if (relative === null) return value;
  if (relative.amount === 0) return 'Today';
  if (relative.unit === 'd' && relative.amount === 1) return 'Tomorrow';
  if (relative.unit === 'd' && relative.amount === -1) return 'Yesterday';
  const size = offsetText(value);
  return relative.amount < 0 ? `${size} ago` : `In ${size}`;
};

/** How an absolute day reads on a chip, in the viewer's locale. */
const absoluteDayLabel = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  if (
    year === undefined ||
    month === undefined ||
    date === undefined ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(date)
  ) {
    return day;
  }
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/** How a stored bound reads: a day in the viewer's locale, or a relative bound in words. */
export const dayLabel = (day: string): string =>
  isRelativeDay(day)
    ? relativeDayLabel(day).toLowerCase()
    : absoluteDayLabel(day);

/**
 * A date bound as a chip's verb and value. A relative bound reads as a window
 * rather than a frozen day: "after -2w" reads "in the last 2 weeks" and
 * "before +1w" reads "within 1 week"; the other pairings keep their verb and
 * read the offset in words. An absolute day keeps its verb and its date.
 */
export const dayBoundChip = (
  op: 'before' | 'after',
  value: string
): { verb: string; summary: string } => {
  const relative = parseRelativeDay(value);
  if (relative === null) return { verb: op, summary: absoluteDayLabel(value) };
  if (op === 'after' && relative.amount < 0) {
    return { verb: 'in the last', summary: offsetText(value) };
  }
  if (op === 'before' && relative.amount > 0) {
    return { verb: 'within', summary: offsetText(value) };
  }
  return { verb: op, summary: relativeDayLabel(value).toLowerCase() };
};

/** A date preset: the label a picker shows and the relative bound it stores. */
export interface DayPreset {
  label: string;
  value: string;
}
