/**
 * The pieces of a team's automatic cycle schedule the settings form reads:
 * the defaults a team starts from, the choices each control offers, and the
 * preview of when the next cycle would run under a draft schedule.
 */

import type { CycleSettingsRead, CycleSettingsUpdate } from '../types/Api';

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
 * When a cycle would start and end under `schedule`, counted from `today`:
 * the first day on or after tomorrow that falls on the start weekday, running
 * for the cycle length. A preview only; the server decides the real dates.
 */
export const previewNextCycle = (
  schedule: Pick<CycleSchedule, 'start_weekday' | 'duration_weeks'>,
  today: Date
): { start: Date; end: Date } => {
  const year = today.getFullYear();
  const month = today.getMonth();
  const tomorrow = today.getDate() + 1;
  const weekday = (new Date(year, month, tomorrow).getDay() + 6) % 7;
  const first = tomorrow + ((schedule.start_weekday - weekday + 7) % 7);
  return {
    start: new Date(year, month, first),
    end: new Date(year, month, first + schedule.duration_weeks * 7 - 1),
  };
};
