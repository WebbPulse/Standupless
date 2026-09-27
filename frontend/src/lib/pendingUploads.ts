/**
 * The attachments a comment composer has uploaded but not yet posted, per
 * issue. The rail reads this to leave them out, because until the comment
 * posts they belong to the draft, and once it posts they belong to the comment,
 * which the rail already hides. Kept outside React so the composer and the rail
 * share it without the page threading ids between them.
 *
 * An id stays held after its comment posts. The comments list takes over hiding
 * it, and releasing it before that list refetches is exactly the flash this
 * exists to prevent. An id is released only when the draft drops the file or
 * the composer goes away without posting it, since the upload then stands on
 * the issue by itself.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** The held attachment ids, one immutable set per issue so snapshots compare by identity. */
const held = new Map<string, ReadonlySet<string>>();

/** Everyone reading the store, notified on every change. */
const listeners = new Set<() => void>();

/** The snapshot for an issue with nothing held. */
const EMPTY: ReadonlySet<string> = new Set();

/** Replaces one issue's set and tells every reader. */
const write = (issueId: string, next: ReadonlySet<string>): void => {
  if (next.size === 0) held.delete(issueId);
  else held.set(issueId, next);
  for (const listener of Array.from(listeners)) listener();
};

/** Hides attachments from the rail while a draft holds them. */
export const holdUploads = (issueId: string, ids: string[]): void => {
  const current = held.get(issueId) ?? EMPTY;
  if (ids.every((id) => current.has(id))) return;
  write(issueId, new Set([...current, ...ids]));
};

/** Lets the rail show attachments a draft no longer holds. */
export const releaseUploads = (issueId: string, ids: string[]): void => {
  const current = held.get(issueId) ?? EMPTY;
  if (!ids.some((id) => current.has(id))) return;
  write(issueId, new Set([...current].filter((id) => !ids.includes(id))));
};

/** The attachment ids held for an issue right now. */
export const heldUploads = (issueId: string): ReadonlySet<string> =>
  held.get(issueId) ?? EMPTY;

/** Subscribes to every change, answering the unsubscribe. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The attachment ids held for an issue, rerendering when they change. */
export const usePendingUploads = (issueId: string): ReadonlySet<string> => {
  const snapshot = useCallback(() => heldUploads(issueId), [issueId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
};
