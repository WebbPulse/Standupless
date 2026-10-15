/**
 * Poll intervals shared across pages. Lookups are the slow moving lists every
 * picker reads, such as teams, statuses, labels, members, saved views and
 * templates. A write invalidates its key at once, and each poll is a
 * conditional read the API answers with a bodiless 304 when nothing changed,
 * so a long interval only bounds how late another person's change shows.
 */

/** How often lookup lists are re-read. */
export const LOOKUP_POLL_MS = 300000;
