/**
 * One person's folded groups, swimlanes and hidden board columns on a list
 * that is not a saved view, such as a team's issues, My issues, a project's
 * or a cycle's issues. They are kept on the server for the signed in person,
 * so they follow them from one device to the next, while a saved view keeps
 * its own folds with the rest of its display.
 *
 * Folds were once kept in the browser alone. The first read of a list that
 * still has such an entry and nothing on the server carries the entry over,
 * and the browser entry is dropped either way.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getListFolds, putListFolds } from '../api/views';
import { errorMessage } from '../lib/errors';
import { showErrorToast } from '../lib/toast';

/** Where folds were kept in the browser before they moved to the server. */
export const legacyFoldsKey = (workspaceId: string, listKey: string): string =>
  `standupless.view.collapsed.${workspaceId}.${listKey}`;

/**
 * Reads and drops a browser entry left from before folds moved to the
 * server. Storage can be missing or hold something another version wrote, so
 * anything unreadable reads as no folds.
 */
export const takeLegacyFolds = (storageKey: string): string[] => {
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (raw === null) return [];
    globalThis.localStorage.removeItem(storageKey);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (row): row is string => typeof row === 'string' && row !== ''
        )
      ),
    ];
  } catch {
    return [];
  }
};

/** What useListFolds returns. */
export interface ListFolds {
  /** The keys folded away on the list. */
  collapsed: ReadonlySet<string>;
  /** Folds or unfolds one key and keeps the change on the server. */
  toggle: (key: string) => void;
  /** Folds or unfolds every key named, in one change kept on the server. */
  set: (keys: readonly string[], folded: boolean) => void;
  /** Unfolds everything, as resetting the list's display does. */
  clear: () => void;
}

/** The folds as held, with the list they belong to. */
interface Held {
  id: string | undefined;
  keys: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The caller's folds on the list named `listKey`. Without a key, as on a saved
 * view, nothing is read or written and the set stays empty. A fold made before
 * the first read lands wins over what the read brings back.
 */
export const useListFolds = (
  workspaceId: string,
  listKey: string | undefined
): ListFolds => {
  const id =
    workspaceId === '' || listKey === undefined
      ? undefined
      : `${workspaceId}\u0000${listKey}`;
  const [held, setHeld] = useState<Held>({ id, keys: NONE });
  const current: Held = held.id === id ? held : { id, keys: NONE };
  if (current !== held) setHeld(current);
  const latest = useRef<Held>(current);
  latest.current = current;
  const touched = useRef<string | undefined>(undefined);
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  const save = useCallback(
    (keys: readonly string[]): void => {
      if (listKey === undefined || workspaceId === '') return;
      writes.current = writes.current
        .catch(() => undefined)
        .then(() => putListFolds(workspaceId, listKey, keys))
        .catch((failure: unknown) => {
          showErrorToast(
            errorMessage(failure, 'Could not keep the folded groups.')
          );
        });
    },
    [workspaceId, listKey]
  );

  useEffect(() => {
    if (id === undefined || listKey === undefined) return;
    touched.current = undefined;
    const legacy = takeLegacyFolds(legacyFoldsKey(workspaceId, listKey));
    if (legacy.length > 0) setHeld({ id, keys: new Set(legacy) });
    const controller = new AbortController();
    getListFolds(workspaceId, listKey, controller.signal)
      .then((read) => {
        if (controller.signal.aborted || touched.current === id) return;
        if (read.collapsed_groups.length > 0) {
          setHeld({ id, keys: new Set(read.collapsed_groups) });
          return;
        }
        if (legacy.length > 0) save(legacy);
      })
      .catch(() => {
        if (!controller.signal.aborted && legacy.length > 0) save(legacy);
      });
    return () => {
      controller.abort();
    };
  }, [id, workspaceId, listKey, save]);

  const toggle = useCallback(
    (key: string): void => {
      if (id === undefined) return;
      touched.current = id;
      const next = new Set(
        latest.current.id === id ? latest.current.keys : NONE
      );
      if (next.has(key)) next.delete(key);
      else next.add(key);
      latest.current = { id, keys: next };
      setHeld(latest.current);
      save([...next]);
    },
    [id, save]
  );

  const set = useCallback(
    (keys: readonly string[], folded: boolean): void => {
      if (id === undefined) return;
      touched.current = id;
      const next = new Set(
        latest.current.id === id ? latest.current.keys : NONE
      );
      for (const key of keys) {
        if (folded) next.add(key);
        else next.delete(key);
      }
      latest.current = { id, keys: next };
      setHeld(latest.current);
      save([...next]);
    },
    [id, save]
  );

  const clear = useCallback((): void => {
    if (id === undefined) return;
    touched.current = id;
    latest.current = { id, keys: NONE };
    setHeld(latest.current);
    save([]);
  }, [id, save]);

  return { collapsed: current.keys, toggle, set, clear };
};

export default useListFolds;
