/**
 * The days a list filter's date bound holds. A relative preset such as "in 1
 * week" resolves to a fixed day when it is picked, so a saved view keeps the
 * day it was saved with, and a chip reads that day back in the viewer's
 * locale. The issue filter bar and the projects filter menu share these so a
 * bound reads the same on both lists.
 */

/** A day as `YYYY-MM-DD` in local time, the way a date input reads it. */
export const isoDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
};

/** The day `days` from today, negative for the past. */
export const dayFromToday = (days: number, today: Date = new Date()): string => {
  const date = new Date(today);
  date.setDate(date.getDate() + days);
  return isoDay(date);
};

/** How a stored day reads on a chip. */
export const dayLabel = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    return day;
  }
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};
