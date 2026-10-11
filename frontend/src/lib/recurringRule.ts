/**
 * A recurring issue's rule in words, for the settings list, kept apart from
 * the component so the sentence is tested on its own.
 */

import type { RecurringFrequency, RecurringIssueRead } from '../types/Api';

/** Weekday abbreviations, Monday first, as the API numbers them 0 to 6. */
export const WEEKDAY_SHORT = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
] as const;

const UNITS: Record<RecurringFrequency, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

/** The schedule as a sentence, such as "Every 2 weeks on Mon, Fri at 09:00 UTC". */
export const describeRule = (
  row: Pick<
    RecurringIssueRead,
    'frequency' | 'interval' | 'weekdays' | 'day_of_month' | 'time' | 'timezone'
  >
): string => {
  const unit = UNITS[row.frequency];
  const every =
    row.interval === 1
      ? row.frequency === 'daily'
        ? 'Every day'
        : `Every ${unit}`
      : `Every ${String(row.interval)} ${unit}s`;
  let on = '';
  if (row.frequency === 'weekly') {
    const days = [...row.weekdays]
      .sort((a, b) => a - b)
      .map((day) => WEEKDAY_SHORT[day] ?? String(day));
    on = ` on ${days.join(', ')}`;
  } else if (row.frequency === 'monthly' && row.day_of_month !== null) {
    on = ` on day ${String(row.day_of_month)}`;
  }
  return `${every}${on} at ${row.time} ${row.timezone}`;
};
