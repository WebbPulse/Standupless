/**
 * A filtered, sorted, cursor paged issue list. Shared by the project page and
 * the cross-workspace "my issues" page, which differ only in which filters they
 * fix rather than in how they read or page.
 */

import React, { useCallback } from 'react';
import { appendIssues, listIssues } from '../../api/issues';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import type {
  IssueListQuery,
  IssueRead,
  LabelRead,
  StatusRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Spinner from '../ui/spinner';
import IssueRow from './IssueRow';

/** Props for IssueList: the read to run and the lists ids resolve against. */
export interface IssueListProps {
  workspaceId: string;
  slug: string;
  /** The filters this list fixes, already merged by the page. */
  query: IssueListQuery;
  /** The refetch key the first page registers under. */
  queryKey: string;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Names each issue's project, for a list that spans more than one. */
  projectNameFor?: (issue: IssueRead) => string | undefined;
  /** The sentence shown when the read succeeds and matches nothing. */
  emptyMessage?: string;
}

/** How many issues one page asks for. */
const PAGE_SIZE = 50;

/** How often the first page is re-read while the list is open. */
const POLL_MS = 60000;

/**
 * Reads issues a page at a time, appending on request.
 *
 * The caller must give this a React `key` that carries the filters, because
 * `usePolledQuery` reads its query function through a ref and restarts only on
 * `enabled` or `intervalMs`. A changed `queryKey` alone subscribes the refetch
 * signal but does not re-read, so a filter change has to remount the list.
 */
export const IssueList: React.FC<IssueListProps> = ({
  workspaceId,
  slug,
  query,
  queryKey,
  statuses,
  labels,
  people,
  projectNameFor,
  emptyMessage = 'No issues match these filters.',
}) => {
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

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, {
      queryKey,
      enabled: workspaceId !== '',
      intervalMs: POLL_MS,
    });

  return (
    <div className="space-y-3">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load these issues.')}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading issues" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((issue) => {
            const projectName = projectNameFor?.(issue);
            return (
              <IssueRow
                key={issue.id}
                issue={issue}
                slug={slug}
                statuses={statuses}
                labels={labels}
                people={people}
                {...(projectName === undefined ? {} : { projectName })}
              />
            );
          })}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}
    </div>
  );
};

export default IssueList;
