/**
 * The pieces of a team's automatic cycle schedule the settings form reads:
 * the defaults a team starts from, the choices each control offers, and the
 * preview of when the next cycle would run under a draft schedule.
 */

import type {
  CycleRead,
  CycleSettingsRead,
  CycleSettingsUpdate,
} from '../types/Api';

/** The editable part of a schedule, every field present. */
export type CycleSchedule = Required<CycleSettingsUpdate>;

/** The schedule a team that never set one reads as. */
export const DEFAULT_CYCLE_SCHEDULE: CycleSchedule = {
  enabled: false,
  duration_weeks: 2,
  cooldown_weeks: 0,
  start_weekday: 0,
  upcoming_count: 2,
  auto_add_started: true,
  auto_add_completed: false,
  move_unfinished: true,
};

/** The weekday names in schedule order, Monday first. */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

/** The lengths a cycle may run, in weeks. */
export const DURATION_WEEKS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/** The cooldowns between cycles, in weeks. */
export const COOLDOWN_WEEKS = [0, 1, 2] as const;

/** How many cycles may be created ahead. */
export const UPCOMING_COUNTS = Array.from({ length: 15 }, (_, i) => i + 1);

/** Reads the editable fields of a stored schedule. */
export const scheduleOf = (settings: CycleSettingsRead): CycleSchedule => ({
  enabled: settings.enabled,
  duration_weeks: settings.duration_weeks,
  cooldown_weeks: settings.cooldown_weeks,
  start_weekday: settings.start_weekday,
  upcoming_count: settings.upcoming_count,
  auto_add_started: settings.auto_add_started,
  auto_add_completed: settings.auto_add_completed ?? false,
  move_unfinished: settings.move_unfinished,
});

/** The fields of `draft` that differ from `saved`, as a patch body. */
export const scheduleChanges = (
  saved: CycleSchedule,
  draft: CycleSchedule
): CycleSettingsUpdate => {
  const changes: CycleSettingsUpdate = {};
  for (const key of Object.keys(draft) as (keyof CycleSchedule)[]) {
    if (draft[key] !== saved[key]) {
      Object.assign(changes, { [key]: draft[key] });
    }
  }
  return changes;
};

/** How many weeks read in the interface, singular for one. */
export const weeksLabel = (weeks: number): string =>
  weeks === 1 ? '1 week' : `${String(weeks)} weeks`;

/** A date in the short form the preview reads, such as "Mon, Oct 5". */
export const formatPreviewDate = (date: Date): string =>
  date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

/**
 * When the next cycle would start and end under `schedule`. With no current
 * cycle it is the first day on or after tomorrow that falls on the start
 * weekday. With one it follows the current cycle's last day and the cooldown,
 * as the server lays out upcoming cycles. A preview only; the server decides
 * the real dates.
 */
export const previewNextCycle = (
  schedule: Pick<CycleSchedule, 'start_weekday' | 'duration_weeks'> &
    Partial<Pick<CycleSchedule, 'cooldown_weeks'>>,
  today: Date,
  currentEnd: Date | null = null
): { start: Date; end: Date } => {
  const from =
    currentEnd === null
      ? today
      : new Date(
          currentEnd.getFullYear(),
          currentEnd.getMonth(),
          currentEnd.getDate() + (schedule.cooldown_weeks ?? 0) * 7
        );
  const year = from.getFullYear();
  const month = from.getMonth();
  const tomorrow = from.getDate() + 1;
  const weekday = (new Date(year, month, tomorrow).getDay() + 6) % 7;
  const first = tomorrow + ((schedule.start_weekday - weekday + 7) % 7);
  return {
    start: new Date(year, month, first),
    end: new Date(year, month, first + schedule.duration_weeks * 7 - 1),
  };
};

/** Reads a `YYYY-MM-DD` date as local midnight, or `null` for none. */
export const parseScheduleDate = (value: string | undefined): Date | null => {
  if (value === undefined) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  return new Date(year, month - 1, day);
};

/** Whether a change moves the dates of the upcoming automatic cycles. */
export const movesUpcoming = (changes: CycleSettingsUpdate): boolean =>
  changes.duration_weeks !== undefined ||
  changes.cooldown_weeks !== undefined ||
  changes.start_weekday !== undefined;

/** The `created_by` of a cycle the automatic schedule made. */
export const SYSTEM_ACTOR = 'system';

/**
 * Whether the schedule may remove an upcoming cycle: one it made, still named
 * as it named it, with no goal, not cancelled and holding no issues.
 */
export const removableCycle = (cycle: CycleRead): boolean =>
  cycle.created_by === SYSTEM_ACTOR &&
  !cycle.cancelled &&
  cycle.number !== undefined &&
  cycle.number !== null &&
  cycle.name === `Cycle ${String(cycle.number)}` &&
  !cycle.goal &&
  cycle.counts.total === 0;

/**
 * What saving `count` upcoming cycles would do to `upcoming`, as the server
 * trims: it walks back from the latest live upcoming cycle beyond the count,
 * removing each removable one, and stops at the first it must keep so the
 * chain gains no hole. A preview only; the server decides.
 */
export const previewTrim = (
  upcoming: CycleRead[],
  count: number
): { removed: number; kept: number } => {
  const live = upcoming
    .filter((cycle) => !cycle.cancelled)
    .sort((a, b) =>
      a.start_date === b.start_date
        ? b.cycle_id.localeCompare(a.cycle_id)
        : b.start_date.localeCompare(a.start_date)
    );
  const surplus = live.slice(0, Math.max(0, live.length - count));
  const stop = surplus.findIndex((cycle) => !removableCycle(cycle));
  const removed = stop === -1 ? surplus.length : stop;
  return { removed, kept: surplus.length - removed };
};

/**
 * The sentence the preview and the save toast read for a trim, empty when
 * nothing is removed or kept. `future` phrases it for the preview.
 */
export const trimSentence = (
  removed: number,
  kept: number,
  future: boolean
): string => {
  const parts: string[] = [];
  if (removed > 0) {
    const cycles = `${String(removed)} empty upcoming ${removed === 1 ? 'cycle' : 'cycles'}`;
    parts.push(future ? `Saving removes ${cycles}.` : `Removed ${cycles}.`);
  }
  if (kept > 0) {
    parts.push(
      kept === 1
        ? '1 upcoming cycle beyond the new count stays because it, or a later cycle, holds issues or was changed by hand.'
        : `${String(kept)} upcoming cycles beyond the new count stay because they, or a later cycle, hold issues or were changed by hand.`
    );
  }
  return parts.join(' ');
};
