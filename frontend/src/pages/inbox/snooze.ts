/**
 * The snooze presets the inbox offers, each resolved to one moment in the
 * viewer's own time. The server takes any timezone aware moment at least a
 * minute out and within 90 days, so every preset here stays inside that.
 */

/** One snooze choice: what it reads as and when it brings the row back. */
export interface SnoozePreset {
  id: string;
  label: string;
  until: (now: Date) => Date;
}

/** The hour of the day a "morning" preset lands on, in local time. */
const MORNING_HOUR = 9;

/** A moment some hours after now. */
const hoursFrom = (now: Date, hours: number): Date =>
  new Date(now.getTime() + hours * 60 * 60 * 1000);

/** The next local morning at least one day after now. */
const tomorrowMorning = (now: Date): Date => {
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(MORNING_HOUR, 0, 0, 0);
  return next;
};

/** The next Monday morning, a full week out when today is already Monday. */
const nextWeekMorning = (now: Date): Date => {
  const next = new Date(now);
  const daysAhead = (8 - next.getDay()) % 7 || 7;
  next.setDate(next.getDate() + daysAhead);
  next.setHours(MORNING_HOUR, 0, 0, 0);
  return next;
};

/** The presets in the order the snooze dialog lists them. */
export const SNOOZE_PRESETS: SnoozePreset[] = [
  { id: 'hour', label: 'In 1 hour', until: (now) => hoursFrom(now, 1) },
  { id: 'later', label: 'In 3 hours', until: (now) => hoursFrom(now, 3) },
  { id: 'tomorrow', label: 'Tomorrow morning', until: tomorrowMorning },
  { id: 'week', label: 'Next week', until: nextWeekMorning },
];

/** A snooze moment as short local text, for the row that is waiting on it. */
export const snoozeLabel = (until: string): string => {
  const moment = new Date(until);
  if (Number.isNaN(moment.getTime())) return 'Snoozed';
  return `Snoozed until ${moment.toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
};
