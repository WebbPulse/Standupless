/**
 * How a timestamp reads in a feed: a short distance from now ("2h ago") for the
 * glance, and the full local date and time for the tooltip that explains it.
 */

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * The distance from `now` to `value`, as a feed shows it. Under a minute is
 * "just now", then minutes, hours and days up to a week, then the date, with
 * the year only when it is not the current one. A value that does not parse is
 * returned as it came, so a malformed row still shows something.
 */
export const relativeTime = (value: string, now: Date = new Date()): string => {
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return value;
  const elapsed = Math.max(0, now.getTime() - time);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS)
    return `${String(Math.floor(elapsed / MINUTE_MS))}m ago`;
  if (elapsed < DAY_MS) return `${String(Math.floor(elapsed / HOUR_MS))}h ago`;
  if (elapsed < 7 * DAY_MS) {
    return `${String(Math.floor(elapsed / DAY_MS))}d ago`;
  }
  const month = MONTHS[parsed.getMonth()] ?? '';
  const day = `${month} ${String(parsed.getDate())}`;
  return parsed.getFullYear() === now.getFullYear()
    ? day
    : `${day}, ${String(parsed.getFullYear())}`;
};

/** The full local date and time, for the tooltip over a relative time. */
export const fullTimestamp = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};
