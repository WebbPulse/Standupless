/**
 * A callback whose identity never changes but which always runs the latest
 * version of the function it was given. Handed to memoized rows, it lets a
 * handler close over data that changes on every poll without making every row
 * render again when it does.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Wraps `fn` in a callback that stays the same object for the component's
 * life and calls the `fn` of the latest committed render. Only for handlers
 * run from events and effects, never for values read while rendering.
 */
export const useLatestCallback = <A extends unknown[], R>(
  fn: (...args: A) => R
): ((...args: A) => R) => {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A): R => latest.current(...args), []);
};

export default useLatestCallback;
