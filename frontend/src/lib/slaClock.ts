/**
 * The clock an SLA timer runs on, mirroring the server's `sla_clock`: plain
 * milliseconds for calendar time, or business time in a team's timezone,
 * which is real elapsed time with every local Saturday and Sunday taken out.
 * A weekday a daylight saving change makes 23 or 25 hours long counts its real
 * hours, and a weekend counts nothing.
 *
 * Every function takes the timer's zone, null for calendar time, where it
 * reduces to plain arithmetic, so the badge reads the same moments as the
 * server whichever clock a team picked.
 */

const SECOND_MS = 1000;

const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** A formatter for the wall clock in `zone`, or null when the zone is unknown. */
const formatterFor = (zone: string): Intl.DateTimeFormat | null => {
  if (formatters.has(zone)) return formatters.get(zone) ?? null;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    formatter = null;
  }
  formatters.set(zone, formatter);
  return formatter;
};

/** A local calendar day as its UTC midnight, so days compare and step as plain numbers. */
type LocalDay = number;

/** The wall clock at `ms` in `zone`, as if that wall time were UTC. */
const wallTime = (ms: number, zone: string): number => {
  const formatter = formatterFor(zone);
  if (formatter === null) return ms;
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  );
};

/** How far the wall clock in `zone` runs ahead of UTC at `ms`. */
const offsetAt = (ms: number, zone: string): number => {
  const whole = Math.floor(ms / SECOND_MS) * SECOND_MS;
  return wallTime(whole, zone) - whole;
};

/** The local calendar day `ms` falls on in `zone`. */
const localDay = (ms: number, zone: string): LocalDay => {
  const wall = wallTime(Math.floor(ms / SECOND_MS) * SECOND_MS, zone);
  const date = new Date(wall);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

/** The day after `day`. */
const nextDay = (day: LocalDay): LocalDay => {
  const date = new Date(day);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1
  );
};

/** The instant local midnight begins `day` in `zone`. */
const dayStart = (day: LocalDay, zone: string): number => {
  const first = day - offsetAt(day, zone);
  return day - offsetAt(first, zone);
};

/** Whether a local day counts toward business time: Monday to Friday. */
const isBusinessDay = (day: LocalDay): boolean => {
  const weekday = new Date(day).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

/** The moment `amount` ms of SLA time after `start`, skipping weekends when a zone is given. */
export const slaAdvance = (
  start: number,
  amount: number,
  zone: string | null | undefined
): number => {
  if (!zone || formatterFor(zone) === null) return start + amount;
  if (amount < 0) return slaRetreat(start, -amount, zone);
  let moment = start;
  let remaining = amount;
  for (;;) {
    const day = localDay(moment, zone);
    const end = Math.max(dayStart(nextDay(day), zone), moment + SECOND_MS);
    if (isBusinessDay(day)) {
      const available = end - moment;
      if (remaining <= available) return moment + remaining;
      remaining -= available;
    }
    moment = end;
  }
};

/** The latest moment `amount` ms of SLA time before `end`, skipping weekends when a zone is given. */
export const slaRetreat = (
  end: number,
  amount: number,
  zone: string | null | undefined
): number => {
  if (!zone || formatterFor(zone) === null) return end - amount;
  if (amount < 0) return slaAdvance(end, -amount, zone);
  let moment = end;
  let remaining = amount;
  for (;;) {
    const day = localDay(moment - 1, zone);
    const start = Math.min(dayStart(day, zone), moment - SECOND_MS);
    if (isBusinessDay(day)) {
      const available = moment - start;
      if (remaining <= available) return moment - remaining;
      remaining -= available;
    }
    moment = start;
  }
};

/** The SLA time between `start` and `end` in ms, negative when `end` comes first. */
export const slaElapsed = (
  start: number,
  end: number,
  zone: string | null | undefined
): number => {
  if (!zone || formatterFor(zone) === null) return end - start;
  if (end < start) return -slaElapsed(end, start, zone);
  let total = 0;
  let moment = start;
  while (moment < end) {
    const day = localDay(moment, zone);
    const dayEnd = Math.min(
      Math.max(dayStart(nextDay(day), zone), moment + SECOND_MS),
      end
    );
    if (isBusinessDay(day)) total += dayEnd - moment;
    moment = dayEnd;
  }
  return total;
};
