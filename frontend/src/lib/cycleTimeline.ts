/**
 * The arithmetic behind the cycles band: where each cycle's bar sits on the
 * shared planning timeline and which lane it takes. A team's cycles never
 * overlap, so they share one lane; a parent team rolling up its sub-teams can
 * hold cycles that do, and each of those drops to the first lane it fits in.
 */

import { dayNumber, type BarDays } from './timeline';
import type { CycleRead } from '../types/Api';

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

/** One cycle placed on the band: its days and the lane it sits in. */
export interface CycleBarPlacement {
  cycle: CycleRead;
  bar: BarDays;
  lane: number;
}

/** The cycles placed on the band, oldest first, and how many lanes they take. */
export interface CycleBandLayout {
  bars: CycleBarPlacement[];
  lanes: number;
}

/** The days a cycle covers, both inclusive, or null when its dates do not read. */
export const cycleBarDays = (cycle: CycleRead): BarDays | null => {
  const start = dayNumber(cycle.start_date);
  const end = dayNumber(cycle.end_date);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
};

/**
 * Orders the cycles by start and gives each the first lane whose last bar
 * ends before it starts, so overlapping cycles stack and the rest share a lane.
 */
export const cycleBandLayout = (
  cycles: readonly CycleRead[]
): CycleBandLayout => {
  const dated = cycles
    .map((cycle) => ({ cycle, bar: cycleBarDays(cycle) }))
    .filter(
      (entry): entry is { cycle: CycleRead; bar: BarDays } => entry.bar !== null
    )
    .sort(
      (a, b) =>
        a.bar.start - b.bar.start ||
        a.bar.end - b.bar.end ||
        a.cycle.cycle_id.localeCompare(b.cycle.cycle_id)
    );
  const laneEnds: number[] = [];
  const bars = dated.map(({ cycle, bar }) => {
    const free = laneEnds.findIndex((end) => end < bar.start);
    const lane = free === -1 ? laneEnds.length : free;
    laneEnds[lane] = bar.end;
    return { cycle, bar, lane };
  });
  return { bars, lanes: Math.max(1, laneEnds.length) };
};

/** A day as a short month and day, such as `Oct 6`. */
const shortDay = (value: string): string => {
  const day = dayNumber(value);
  if (day === null) return value;
  const date = new Date(day * 86400000);
  return `${MONTHS[date.getUTCMonth()] ?? ''} ${String(date.getUTCDate())}`;
};

/** A cycle's dates as the band reads them, such as `Oct 6 to Oct 19`. */
export const cycleBandDates = (cycle: {
  start_date: string;
  end_date: string;
}): string => `${shortDay(cycle.start_date)} to ${shortDay(cycle.end_date)}`;

/** The bar's neighbour a key moves focus to, or null when the key does not move it. */
export const neighbourIndex = (
  key: string,
  index: number,
  count: number
): number | null => {
  if (count === 0) return null;
  if (key === 'ArrowLeft') return Math.max(0, index - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, index + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
};
