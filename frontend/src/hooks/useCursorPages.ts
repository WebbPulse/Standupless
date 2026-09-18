/**
 * Cursor paging on top of the shared polled query. The first page is the polled
 * read, so a filter change or a write re-reads it the way every other list in
 * this application does; the pages a person loaded after it are held beside it
 * and cleared when the key changes, because a cursor taken against the old
 * filters does not describe the new list.
 */

import { useCallback, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  serializeQueryKey,
  usePolledQuery,
  type QueryKey,
} from '@webbpulse/api-client/react';

/** One cursor page: the rows and the cursor that follows them, or null at the end. */
export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
}

/** Options for {@link useCursorPages}. */
export interface CursorPagesOptions {
  /**
   * The key identifying the first page. Carrying the filters in it restarts the
   * read when they change, so the caller does not have to remount.
   */
  queryKey: QueryKey;
  /** False while the ids the read needs are still unknown. */
  enabled: boolean;
  /** Milliseconds between polls of the first page. */
  intervalMs: number;
}

/** What {@link useCursorPages} returns. */
export interface CursorPagesResult<T> {
  /** Every row loaded so far, the first page followed by the ones after it. */
  rows: T[];
  error: unknown;
  isLoading: boolean;
  /** True while a later page is being fetched. */
  isPaging: boolean;
  /** Whether another page exists to load. */
  hasMore: boolean;
  /** Fetches the next page and appends it. */
  loadMore: () => void;
}

/** What the hook holds for the pages loaded after the first one. */
interface LaterPages<T> {
  rows: T[];
  nextCursor: string | null;
}

/**
 * Reads the first page on a poll and appends later pages on request.
 *
 * `read` must change identity exactly when the read itself does, which the
 * callers get by wrapping it in `useCallback` over their filters. `merge`
 * decides how a page joins the rows already held, so a caller can drop the
 * overlap a cursor can repeat.
 *
 * The later pages are dropped in the same render that changes the key or lands
 * a new first page, rather than a render later, so a cursor taken against the
 * old filters is never merged into the new list.
 */
export const useCursorPages = <T>(
  read: (
    cursor: string | undefined,
    signal?: AbortSignal
  ) => Promise<CursorPage<T>>,
  merge: (held: T[], incoming: T[]) => T[],
  options: CursorPagesOptions
): CursorPagesResult<T> => {
  const auth = useQueryAuth();
  const [later, setLater] = useState<LaterPages<T> | null>(null);
  const [isPaging, setIsPaging] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => read(undefined, signal),
    {
      intervalMs: options.intervalMs,
      enabled: options.enabled,
      queryKey: options.queryKey,
      auth,
    }
  );

  const serialisedKey = serializeQueryKey(options.queryKey);
  const anchorRef = useRef<{ key: string; first: CursorPage<T> | null }>({
    key: serialisedKey,
    first: data,
  });
  const anchor = anchorRef.current;
  const isReset = anchor.key !== serialisedKey || anchor.first !== data;

  if (isReset) {
    anchorRef.current = { key: serialisedKey, first: data };
  }

  const held = isReset ? null : later;
  if (isReset && later !== null) setLater(null);

  const first: CursorPage<T> = data ?? { rows: [], nextCursor: null };
  const rows = held === null ? first.rows : merge(first.rows, held.rows);
  const cursor = held === null ? first.nextCursor : held.nextCursor;

  const loadMore = useCallback(() => {
    if (cursor === null || isPaging) return;
    setIsPaging(true);
    read(cursor)
      .then((page) => {
        setLater((held) => ({
          rows: held === null ? page.rows : merge(held.rows, page.rows),
          nextCursor: page.nextCursor,
        }));
      })
      .catch(() => undefined)
      .finally(() => {
        setIsPaging(false);
      });
  }, [read, merge, cursor, isPaging]);

  return {
    rows,
    error,
    isLoading,
    isPaging,
    hasMore: cursor !== null,
    loadMore,
  };
};
