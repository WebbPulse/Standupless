/**
 * Coarse planning dates, the way Linear sets them: a project or initiative
 * date is an exact day, or a whole month, quarter, half or year.
 *
 * The API stores a coarse date as one real day beside its resolution, a
 * start at the first day of its period and a target at the last. Sorting,
 * filters and the timeline keep reading the plain date, so a coarse target
 * sorts and draws at the end of its period, and only the label and the
 * approximate end cap need to know the resolution.
 */

import type { DateResolution } from '../types/Api';
import { parseIsoDate, shortDateLabel } from './propertyOptions';

/** Every resolution a planning date can take, finest first. */
export const DATE_RESOLUTIONS: readonly DateResolution[] = [
  'day',
  'month',
  'quarter',
  'half',
  'year',
];

/** The tab name each resolution reads as in the date picker. */
export const RESOLUTION_LABELS: Record<DateResolution, string> = {
  day: 'Day',
  month: 'Month',
  quarter: 'Quarter',
  half: 'Half',
  year: 'Year',
};

/** Which edge of its period a date is held at: a start opens it, a target closes it. */
export type DateEdge = 'start' | 'end';

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

/** Whether a resolution is coarser than a day. */
export const isCoarse = (
  resolution: DateResolution | null | undefined
): resolution is Exclude<DateResolution, 'day'> =>
  resolution !== undefined && resolution !== null && resolution !== 'day';

/** The first and last month, one based, of the period a month falls in. */
const periodMonths = (
  month: number,
  resolution: Exclude<DateResolution, 'day'>
): [number, number] => {
  if (resolution === 'month') return [month, month];
  if (resolution === 'quarter') {
    const first = Math.floor((month - 1) / 3) * 3 + 1;
    return [first, first + 2];
  }
  if (resolution === 'half') return month <= 6 ? [1, 6] : [7, 12];
  return [1, 12];
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** The year and one based month of an ISO day, without a time zone shift. */
const yearMonth = (value: string): [number, number] => [
  Number(value.slice(0, 4)),
  Number(value.slice(5, 7)),
];

/** The first day of the period `value` falls in, or `value` itself for a day. */
export const periodStart = (
  value: string,
  resolution: DateResolution | null | undefined
): string => {
  if (!isCoarse(resolution)) return value;
  const [year, month] = yearMonth(value);
  const [first] = periodMonths(month, resolution);
  return `${year}-${pad(first)}-01`;
};

/** The last day of the period `value` falls in, or `value` itself for a day. */
export const periodEnd = (
  value: string,
  resolution: DateResolution | null | undefined
): string => {
  if (!isCoarse(resolution)) return value;
  const [year, month] = yearMonth(value);
  const [, last] = periodMonths(month, resolution);
  const days = new Date(Date.UTC(year, last, 0)).getUTCDate();
  return `${year}-${pad(last)}-${pad(days)}`;
};

/** One date moved to the start or the end of its period. */
export const snapDate = (
  value: string,
  resolution: DateResolution | null | undefined,
  edge: DateEdge
): string =>
  edge === 'start'
    ? periodStart(value, resolution)
    : periodEnd(value, resolution);

/** A coarse period as people name it: `Nov 2026`, `Q3 2026`, `H2 2026` or `2026`. */
export const periodLabel = (
  value: string,
  resolution: Exclude<DateResolution, 'day'>
): string => {
  const [year, month] = yearMonth(value);
  if (resolution === 'month') return `${MONTHS[month - 1] ?? ''} ${year}`;
  if (resolution === 'quarter')
    return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
  if (resolution === 'half') return `H${month <= 6 ? 1 : 2} ${year}`;
  return String(year);
};

/**
 * A planning date as it shows everywhere: the period for a coarse date, and
 * the short day label every other date uses for an exact one.
 */
export const planningDateLabel = (
  value: string,
  resolution: DateResolution | null | undefined,
  today = new Date()
): string =>
  isCoarse(resolution) && parseIsoDate(value) !== null
    ? periodLabel(value, resolution)
    : shortDateLabel(value, today);

/** One period a coarse tab of the date picker offers. */
export interface PeriodChoice {
  /** The period's name, such as `Q3`, or the year on the year tab. */
  label: string;
  /** The period's full name, such as `Q3 2026`. */
  name: string;
  /** The day the period is stored as at the asked edge. */
  value: string;
}

/**
 * The periods a coarse tab offers for one year: twelve months, four quarters
 * or two halves. The year tab offers six years starting at `year`.
 */
export const periodChoices = (
  year: number,
  resolution: Exclude<DateResolution, 'day'>,
  edge: DateEdge
): PeriodChoice[] => {
  const choose = (anchor: string, label: string): PeriodChoice => ({
    label,
    name: periodLabel(anchor, resolution),
    value: snapDate(anchor, resolution, edge),
  });
  if (resolution === 'year') {
    return Array.from({ length: 6 }, (_, index) =>
      choose(`${year + index}-01-01`, String(year + index))
    );
  }
  const step = resolution === 'month' ? 1 : resolution === 'quarter' ? 3 : 6;
  return Array.from({ length: 12 / step }, (_, index) => {
    const anchor = `${year}-${pad(index * step + 1)}-01`;
    const label =
      resolution === 'month'
        ? (MONTHS[index] ?? '')
        : resolution === 'quarter'
          ? `Q${index + 1}`
          : `H${index + 1}`;
    return choose(anchor, label);
  });
};
