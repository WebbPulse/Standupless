/**
 * Someone else's local time, as a member hover card shows it: the clock in
 * their zone and how far it sits from the viewer's, after Linear's
 * "10:42 PM, 5h ahead". A zone the runtime does not know reads as nothing, so
 * a stale or mistyped preference never breaks the card.
 */

import { viewerTimezone } from './viewerTimezone';

/** A member's local time and its distance from the viewer's. */
export interface LocalTime {
  /** The clock in the member's zone, such as `10:42 PM`. */
  time: string;
  /** How the member's clock sits against the viewer's, such as `5h ahead`. */
  offset: string;
}

/** The zone's offset from UTC at `now`, in minutes, or null for a zone the runtime refuses. */
export const zoneOffsetMinutes = (zone: string, now: Date): number | null => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(now);
  } catch {
    return null;
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value ?? '0');
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour') % 24,
    part('minute')
  );
  const instant = Math.floor(now.getTime() / 60000) * 60000;
  return Math.round((wall - instant) / 60000);
};

/** A difference in minutes as hours, with the minutes only when they are not whole. */
const hoursLabel = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return `${String(hours)}h`;
  return hours === 0
    ? `${String(rest)}m`
    : `${String(hours)}h ${String(rest)}m`;
};

/** How a clock `delta` minutes from the viewer's reads. */
export const offsetLabel = (delta: number): string => {
  if (delta === 0) return 'same time as you';
  const label = hoursLabel(Math.abs(delta));
  return delta > 0 ? `${label} ahead` : `${label} behind`;
};

/**
 * The member's local time in `zone` at `now`, measured against the viewer's
 * zone, or null when either zone is unknown or the member set none.
 */
export const localTimeIn = (
  zone: string | null | undefined,
  now: Date = new Date(),
  viewerZone: string = viewerTimezone()
): LocalTime | null => {
  if (zone === null || zone === undefined || zone === '') return null;
  const theirs = zoneOffsetMinutes(zone, now);
  const mine = zoneOffsetMinutes(viewerZone, now);
  if (theirs === null || mine === null) return null;
  const time = new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  return { time, offset: offsetLabel(theirs - mine) };
};
