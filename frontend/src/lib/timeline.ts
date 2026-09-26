/**
 * The calendar arithmetic the roadmap timeline draws with. Days are counted as
 * whole UTC day numbers so a `YYYY-MM-DD` value maps to exactly one column and
 * a drag moves a bar by whole days, whatever the viewer's time zone.
 */

/** One day in milliseconds. */
const DAY_MS = 86400000;

/** How far the timeline is zoomed. */
export type TimelineZoom = 'week' | 'month' | 'quarter' | 'year';

/** The zoom levels from closest to widest. */
export const TIMELINE_ZOOMS: TimelineZoom[] = [
  'week',
  'month',
  'quarter',
  'year',
];

/** How each zoom level reads in the zoom control. */
export const TIMELINE_ZOOM_LABELS: Record<TimelineZoom, string> = {
  week: 'Weeks',
  month: 'Months',
  quarter: 'Quarters',
  year: 'Year',
};

/** How many pixels one day takes at each zoom level. */
export const PX_PER_DAY: Record<TimelineZoom, number> = {
  week: 32,
  month: 10,
  quarter: 4,
  year: 1.6,
};

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

/** Reads a `YYYY-MM-DD` value as a day number, or null when it is not one. */
export const dayNumber = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const time = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  return Number.isNaN(time) ? null : Math.floor(time / DAY_MS);
};

/** Formats a day number as the `YYYY-MM-DD` the contract takes. */
export const dayValue = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The viewer's local calendar day as a day number. */
export const todayNumber = (now = new Date()): number =>
  Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS
  );

/** The first day of the month a day falls in. */
const monthStart = (day: number): number => {
  const date = new Date(day * DAY_MS);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / DAY_MS
  );
};

/** The first day of the month after the one a day falls in. */
const nextMonthStart = (day: number): number => {
  const date = new Date(day * DAY_MS);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS
  );
};

/** The span of days the timeline draws, end exclusive. */
export interface TimelineRange {
  start: number;
  end: number;
}

/**
 * The days the timeline spans: every dated bar, and today with room either
 * side, widened to whole months so the header never starts mid month.
 */
export const timelineRange = (
  dates: (string | null)[],
  today: number
): TimelineRange => {
  const days = dates
    .map(dayNumber)
    .filter((day): day is number => day !== null);
  const first = Math.min(today - 60, ...days) - 14;
  const last = Math.max(today + 180, ...days) + 30;
  return { start: monthStart(first), end: nextMonthStart(last) };
};

/** One labelled span along a header row. */
export interface TimelineTick {
  day: number;
  span: number;
  label: string;
}

/** The two header rows the timeline shows at a zoom level. */
export interface TimelineHeader {
  major: TimelineTick[];
  minor: TimelineTick[];
}

const monthLabel = (day: number): string => {
  const date = new Date(day * DAY_MS);
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCFullYear())}`;
};

const quarterLabel = (day: number): string => {
  const date = new Date(day * DAY_MS);
  return `Q${String(Math.floor(date.getUTCMonth() / 3) + 1)} ${String(date.getUTCFullYear())}`;
};

/** Splits a range at every day where `boundary` says a new span starts. */
const spans = (
  range: TimelineRange,
  isBoundary: (day: number) => boolean,
  label: (day: number) => string
): TimelineTick[] => {
  const ticks: TimelineTick[] = [];
  for (let day = range.start; day < range.end; day += 1) {
    const last = ticks[ticks.length - 1];
    if (last === undefined || isBoundary(day)) {
      ticks.push({ day, span: 1, label: label(day) });
    } else {
      last.span += 1;
    }
  }
  return ticks;
};

const utc = (day: number): Date => new Date(day * DAY_MS);

/**
 * The header rows for a zoom level: months over weeks when zoomed in, then
 * months over days of the month, quarters over months, and years over
 * quarters when zoomed out.
 */
export const timelineHeader = (
  range: TimelineRange,
  zoom: TimelineZoom
): TimelineHeader => {
  const isMonth = (day: number): boolean => utc(day).getUTCDate() === 1;
  const isQuarter = (day: number): boolean =>
    isMonth(day) && utc(day).getUTCMonth() % 3 === 0;
  const isYear = (day: number): boolean =>
    isMonth(day) && utc(day).getUTCMonth() === 0;
  const isMonday = (day: number): boolean => utc(day).getUTCDay() === 1;
  const monthName = (day: number): string =>
    MONTHS[utc(day).getUTCMonth()] ?? '';
  const dayOfMonth = (day: number): string => String(utc(day).getUTCDate());

  if (zoom === 'week') {
    return {
      major: spans(range, isMonth, monthLabel),
      minor: spans(range, () => true, dayOfMonth),
    };
  }
  if (zoom === 'month') {
    return {
      major: spans(range, isMonth, monthLabel),
      minor: spans(range, isMonday, dayOfMonth),
    };
  }
  if (zoom === 'quarter') {
    return {
      major: spans(range, isQuarter, quarterLabel),
      minor: spans(range, isMonth, monthName),
    };
  }
  return {
    major: spans(range, isYear, (day) => String(utc(day).getUTCFullYear())),
    minor: spans(
      range,
      isQuarter,
      (day) => quarterLabel(day).split(' ')[0] ?? ''
    ),
  };
};

/** Which part of a bar a drag holds. */
export type DragMode = 'move' | 'start' | 'end';

/** A bar's two days, both inclusive. */
export interface BarDays {
  start: number;
  end: number;
}

/**
 * Where a bar lands after a drag of `delta` days. Moving shifts both ends;
 * resizing moves one end and stops it at the other, so a bar is never less
 * than a day long and a target never falls before its start.
 */
export const dragBar = (
  bar: BarDays,
  mode: DragMode,
  delta: number
): BarDays => {
  if (mode === 'move')
    return { start: bar.start + delta, end: bar.end + delta };
  if (mode === 'start') {
    return { start: Math.min(bar.start + delta, bar.end), end: bar.end };
  }
  return { start: bar.start, end: Math.max(bar.end + delta, bar.start) };
};

/**
 * The days a project's bar covers, or null when it has neither date. A project
 * with only one date is drawn as a single day on it, so it can still be
 * dragged into shape.
 */
export const barDays = (
  startDate: string | null,
  targetDate: string | null
): BarDays | null => {
  const start = dayNumber(startDate);
  const end = dayNumber(targetDate);
  if (start === null && end === null) return null;
  const from = start ?? end ?? 0;
  const to = end ?? start ?? 0;
  return { start: Math.min(from, to), end: Math.max(from, to) };
};

/**
 * Where a bar's label sits so it stays readable while the bar is partly
 * scrolled out of view: at the bar's start, pushed right to the visible edge,
 * and never past the bar's end less the label's width.
 */
export const clampLabel = (
  barLeft: number,
  barWidth: number,
  viewLeft: number,
  labelWidth: number
): number => {
  const latest = Math.max(barLeft, barLeft + barWidth - labelWidth);
  return Math.min(Math.max(barLeft, viewLeft), latest);
};

/** Which side of the view a bar lies wholly beyond, or null when any of it shows. */
export const offscreenSide = (
  barLeft: number,
  barWidth: number,
  viewLeft: number,
  viewRight: number
): 'before' | 'after' | null => {
  if (barLeft + barWidth < viewLeft) return 'before';
  if (barLeft > viewRight) return 'after';
  return null;
};
