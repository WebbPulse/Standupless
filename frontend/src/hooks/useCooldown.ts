/**
 * A countdown that blocks an action for a stretch after it runs, such as
 * resending a verification email.
 */

import { useCallback, useEffect, useState } from 'react';

/** Seconds a resend waits before it can be sent again. */
export const RESEND_COOLDOWN_SECONDS = 60;

/** What `useCooldown` hands back: seconds left and the call that starts it. */
export interface Cooldown {
  remaining: number;
  start: () => void;
}

/** Counts `seconds` down to zero once `start` is called, one tick a second. */
export const useCooldown = (
  seconds: number = RESEND_COOLDOWN_SECONDS
): Cooldown => {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => {
      setRemaining((left) => Math.max(0, left - 1));
    }, 1000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [remaining]);

  const start = useCallback(() => {
    setRemaining(seconds);
  }, [seconds]);

  return { remaining, start };
};
