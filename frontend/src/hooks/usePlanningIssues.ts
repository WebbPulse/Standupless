/**
 * The issues of one project or cycle, read a page at a time. The project and
 * cycle pages group, count and chart the same rows, so they read them once
 * here rather than each child running its own list.
 */

import { useCallback } from 'react';
import type { QueryKey } from '@webbpulse/api-client/react';
import { appendIssues, listIssues } from '../api/issues';
import type { IssueListQuery, IssueRead } from '../types/Api';
import {
  useCursorPages,
  type CursorPage,
  type CursorPagesResult,
} from './useCursorPages';

/** How many issues one page asks for, the most the list route allows. */
const PAGE_SIZE = 100;

/** How often the first page is re-read while the page is open. */
const POLL_MS = 30000;

/**
 * Reads the issues the query names. The query is compared by value, so a new
 * object with the same filters does not restart the read.
 */
export const usePlanningIssues = (
  workspaceId: string,
  query: IssueListQuery,
  queryKey: QueryKey,
  enabled: boolean
): CursorPagesResult<IssueRead> => {
  const serialised = JSON.stringify(query);

  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<IssueRead>> => {
      const page = await listIssues(
        workspaceId,
        {
          ...(JSON.parse(serialised) as IssueListQuery),
          limit: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal
      );
      return { rows: page.issues, nextCursor: page.next_cursor };
    },
    [workspaceId, serialised]
  );

  const merge = useCallback(
    (held: IssueRead[], incoming: IssueRead[]): IssueRead[] =>
      appendIssues(held, { issues: incoming, next_cursor: null }),
    []
  );

  return useCursorPages(read, merge, {
    queryKey,
    enabled: enabled && workspaceId !== '',
    intervalMs: POLL_MS,
  });
};

export default usePlanningIssues;
