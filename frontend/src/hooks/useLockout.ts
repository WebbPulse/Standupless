/**
 * Holds a form shut through a second-factor lockout. `lock` takes a step-up
 * refusal and, when it is a lockout, starts a countdown that keeps `message`
 * current and lifts `locked` once the wait is over.
 */

import { useCallback, useEffect, useState } from 'react';
import { lockedUntilFrom, lockoutMessage } from '../lib/lockout';

/** The lockout state a form reads, and the call that starts one. */
export interface LockoutState {
  locked: boolean;
  /** The inline error while locked, or null. */
  message: string | null;
  /** Starts a lockout from a refusal. Returns true when it was one. */
  lock: (failure: unknown) => boolean;
}

/** Tracks one lockout from refusal to expiry. */
export const useLockout = (): LockoutState => {
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) setUntil(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);

  const lock = useCallback((failure: unknown): boolean => {
    const current = Date.now();
    const next = lockedUntilFrom(failure, current);
    if (next === null) return false;
    setNow(current);
    setUntil(next);
    return true;
  }, []);

  const remaining = until === null ? 0 : until - now;
  return {
    locked: remaining > 0,
    message: remaining > 0 ? lockoutMessage(remaining) : null,
    lock,
  };
};
