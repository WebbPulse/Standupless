/**
 * A filtered, sorted, cursor paged issue list. Shared by the team page and
 * the cross-workspace "my issues" page, which differ only in which filters they
 * fix rather than in how they read or page. Renders flat and edge to edge, so
 * the page places it in a flush shell body.
 */

import React, { useCallback } from 'react';
import type { QueryKey } from '@webbpulse/api-client/react';
import { LuInbox } from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import { appendIssues, listIssues } from '../../api/issues';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
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
import EmptyState from '../ui/empty-state';
import { SkeletonRows } from '../ui/skeleton';
import IssueRow from './IssueRow';

/** Props for IssueList: the read to run and the lists ids resolve against. */
export interface IssueListProps {
  workspaceId: string;
  slug: string;
  /** The filters this list fixes, already merged by the page. */
  query: IssueListQuery;
  /**
   * The key identifying this read. It carries the filters, so changing them
   * restarts the list.
   */
  queryKey: QueryKey;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Names each issue's team, for a list that spans more than one. */
  teamNameFor?: (issue: IssueRead) => string | undefined;
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
 * The filters live in `queryKey`, which `usePolledQuery` compares by value, so
 * changing them restarts the read on its own. While the new first page is in
 * flight the list shows placeholder rows rather than the rows the old filters
 * matched, so the page keeps its height instead of collapsing around a spinner.
 *
 * j, k and the arrow keys move a highlight through the rows, Enter opens the
 * highlighted issue and Escape clears the highlight.
 */
export const IssueList: React.FC<IssueListProps> = ({
  workspaceId,
  slug,
  query,
  queryKey,
  statuses,
  labels,
  people,
  teamNameFor,
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

  const navigate = useNavigate();

  const onActivate = useCallback(
    (index: number) => {
      const issue = rows[index];
      if (issue !== undefined) void navigate(`/w/${slug}/issues/${issue.key}`);
    },
    [rows, navigate, slug]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: rows.length,
    onActivate,
    resetKey: serialised,
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load these issues.')}
          />
        </div>
      )}

      {isLoading ? (
        <SkeletonRows label="Loading issues" />
      ) : rows.length === 0 ? (
        <EmptyState message={emptyMessage} icon={<LuInbox />} />
      ) : (
        <ul>
          {rows.map((issue, index) => {
            const teamName = teamNameFor?.(issue);
            return (
              <IssueRow
                key={issue.id}
                issue={issue}
                slug={slug}
                statuses={statuses}
                labels={labels}
                people={people}
                isActive={index === activeIndex}
                rowRef={registerItem(index)}
                onPointerEnter={() => {
                  setActiveIndex(index);
                }}
                {...(teamName === undefined ? {} : { teamName })}
              />
            );
          })}
        </ul>
      )}

      {hasMore && !isLoading && (
        <div className="px-4 py-2 lg:px-6">
          <Button
            variant="ghost"
            size="sm"
            disabled={isPaging}
            onClick={loadMore}
          >
            {isPaging ? 'Loading' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
};

export default IssueList;
