/**
 * Whether the primary pointer is coarse, a finger rather than a mouse or a
 * pen, kept current as it changes. Touch gestures on rows switch on from this.
 * Unlike `useMediaQuery`, a missing matchMedia, as in jsdom, answers false,
 * so tests and prerendering see the mouse layout with row drag intact.
 */

import { useSyncExternalStore } from 'react';

/** The query a finger as the primary pointer matches. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** Subscribes to changes of the query, where matchMedia exists. */
const subscribe = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return () => undefined;
  const list = window.matchMedia(COARSE_POINTER_QUERY);
  list.addEventListener('change', onChange);
  return () => {
    list.removeEventListener('change', onChange);
  };
};

/** Whether the query matches now, false without matchMedia. */
const snapshot = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(COARSE_POINTER_QUERY).matches;

/** Whether the primary pointer is a finger. */
export const useCoarsePointer = (): boolean =>
  useSyncExternalStore(subscribe, snapshot, () => false);
