/**
 * The second-factor lockout as the forms show it: after too many wrong codes
 * the identity service refuses with a `rate-limited` outcome carrying how long
 * to wait, and the form says so and holds its submit until then.
 */

/** The wait assumed when a lockout names none, in seconds. */
export const LOCKOUT_FALLBACK_SECONDS = 60;

/**
 * When a refusal's lockout ends, in epoch milliseconds, or null when the
 * refusal is not a lockout.
 */
export const lockedUntilFrom = (
  failure: unknown,
  now: number = Date.now()
): number | null => {
  if (typeof failure !== 'object' || failure === null) return null;
  const { reason, retryAfter } = failure as {
    reason?: unknown;
    retryAfter?: unknown;
  };
  if (reason !== 'rate-limited') return null;
  const seconds =
    typeof retryAfter === 'number' && Number.isFinite(retryAfter)
      ? Math.max(0, retryAfter)
      : LOCKOUT_FALLBACK_SECONDS;
  return now + seconds * 1000;
};

/** The inline error for a lockout with `remainingMs` left, in whole minutes. */
export const lockoutMessage = (remainingMs: number): string => {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  return `Too many attempts, try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
};
