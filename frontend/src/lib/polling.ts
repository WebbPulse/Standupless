import { useRealtimeHealthy } from './realtime';

/**
 * Poll intervals shared across pages. Lookups are the slow moving lists every
 * picker reads, such as teams, statuses, labels, members, saved views and
 * templates. A write invalidates its key at once, and each poll is a
 * conditional read the API answers with a bodiless 304 when nothing changed,
 * so a long interval only bounds how late another person's change shows.
 *
 * While a change socket is open its notices refresh the reads they name within
 * a second, so those reads poll less often and the poll becomes the fallback
 * that catches anything a notice missed.
 */

/** How often lookup lists are re-read. */
export const LOOKUP_POLL_MS = 300000;

/** How much longer a notice covered poll waits while the change socket is healthy. */
export const REALTIME_POLL_FACTOR = 4;

/** The interval for a notice covered read, stretched while the socket is healthy. */
export const relaxedPollMs = (baseMs: number, healthy: boolean): number =>
  healthy ? baseMs * REALTIME_POLL_FACTOR : baseMs;

/** {@link relaxedPollMs} against the live socket health. */
export const useRealtimePollMs = (baseMs: number): number =>
  relaxedPollMs(baseMs, useRealtimeHealthy());
