/**
 * The viewer's own timezone, the one due date reminders are judged in, so the
 * issue page calls a date overdue on the same day the reminder arrives.
 *
 * The signed in profile sets it once loaded; until then, and for a profile
 * with none stored, the browser's zone stands in.
 */


let stored: string | null = null;

/** The caller's IANA timezone, or UTC where the runtime cannot say. */
export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** Records the zone stored on the signed in profile, or clears it with null. */
export const setViewerTimezone = (zone: string | null | undefined): void => {
  stored = zone ?? null;
};

/** The zone dates are judged in: the stored one, else the browser's. */
export const viewerTimezone = (): string => stored ?? browserTimezone();

/** Today's date as YYYY-MM-DD in `zone`, falling back to UTC for a zone the runtime refuses. */
export const todayIn = (zone: string, now: Date = new Date()): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
};

/** Whether a YYYY-MM-DD due date has passed on the viewer's calendar. */
export const isPastDue = (due: string, now: Date = new Date()): boolean =>
  due < todayIn(viewerTimezone(), now);
