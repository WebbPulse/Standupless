/**
 * Every direct child of one issue, read under the shared children key so the
 * issue page and the peek pane hold one copy: a status picked or a child
 * added on either surface shows on the other without its own read. The first
 * page polls, and later pages are read one after another until the list is
 * whole, since the sub-issues section counts and orders the full set.
 */

import { useCallback, useEffect } from 'react';
import { appendIssues, listChildren } from '../api/issues';
import { childrenKey } from '../lib/queryKeys';
import type { IssueRead } from '../types/Api';
import {
  useCursorPages,
  type CursorPage,
  type CursorPagesResult,
} from './useCursorPages';

/** How many children one page reads. */
const CHILDREN_PAGE = 50;

/** How often the first page is re-read. */
const POLL_MS = 60000;

/** Reads all of an issue's children while `enabled` holds. */
export const useIssueChildren = (
  workspaceId: string,
  issueId: string,
  enabled = true
): CursorPagesResult<IssueRead> => {
  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<IssueRead>> => {
      const page = await listChildren(
        workspaceId,
        issueId,
        { limit: CHILDREN_PAGE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.issues, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );
  const merge = useCallback(
    (held: IssueRead[], incoming: IssueRead[]): IssueRead[] =>
      appendIssues(held, { issues: incoming, next_cursor: null }),
    []
  );
  const children = useCursorPages(read, merge, {
    queryKey: childrenKey(issueId),
    enabled: enabled && workspaceId !== '' && issueId !== '',
    intervalMs: POLL_MS,
  });
  const { hasMore, isPaging, isLoading, loadMore } = children;
  useEffect(() => {
    if (hasMore && !isPaging && !isLoading) loadMore();
  }, [hasMore, isPaging, isLoading, loadMore]);
  return children;
};
