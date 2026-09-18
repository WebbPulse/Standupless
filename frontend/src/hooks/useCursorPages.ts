/**
 * Cursor paging on top of the shared polled query. The first page is the polled
 * read, so a filter change or a write re-reads it the way every other list in
 * this application does; the pages a person loaded after it are held beside it
 * and cleared when the first page changes, because a cursor taken against the
 * old filters does not describe the new list.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useQueryAuth } from './useQueryAuth';

/** One cursor page: the rows and the cursor that follows them, or null at the end. */
export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
}

/** Options for {@link useCursorPages}. */
export interface CursorPagesOptions {
  /** The refetch key the first page registers under. */
  queryKey: string;
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
      ...(auth === undefined ? {} : { auth }),
    }
  );

  const firstRef = useRef(data);
  useEffect(() => {
    if (firstRef.current !== data) {
      firstRef.current = data;
      setLater(null);
    }
  }, [data]);

  const first: CursorPage<T> = data ?? { rows: [], nextCursor: null };
  const rows = later === null ? first.rows : merge(first.rows, later.rows);
  const cursor = later === null ? first.nextCursor : later.nextCursor;

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
