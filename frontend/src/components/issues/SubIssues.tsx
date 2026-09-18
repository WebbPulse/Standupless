/**
 * The direct children of one issue, with the progress bar the rollup consumer
 * maintains. The bar reads `progress` on the parent rather than counting the
 * rows here, because the rows are one cursor page and the count is not.
 */

import React, { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { appendIssues, listChildren } from '../../api/issues';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import { progressPercent } from '../../lib/issueDisplay';
import { childrenKey } from '../../lib/queryKeys';
import type { IssueProgress, IssueRead, StatusRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Spinner from '../ui/spinner';

/** Props for SubIssues: which parent, its rolled up counts, and the slug to link with. */
export interface SubIssuesProps {
  workspaceId: string;
  issueId: string;
  slug: string;
  progress: IssueProgress;
  statuses: StatusRead[];
}

/** How many children one page asks for. */
const PAGE_SIZE = 50;

/** How often the first page of children is re-read while the issue is open. */
const POLL_MS = 60000;

/** Lists one issue's direct children under its progress bar. */
export const SubIssues: React.FC<SubIssuesProps> = ({
  workspaceId,
  issueId,
  slug,
  progress,
  statuses,
}) => {
  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<IssueRead>> => {
      const page = await listChildren(
        workspaceId,
        issueId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
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

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, {
      queryKey: childrenKey(issueId),
      enabled: workspaceId !== '' && issueId !== '',
      intervalMs: POLL_MS,
    });

  const percent = progressPercent(progress);

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-white">Sub-issues</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the sub-issues.')}
        />
      )}

      {progress.total > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-slate-400">
            {progress.completed} of {progress.total} done
          </p>
          <div
            role="progressbar"
            aria-label="Sub-issue progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full overflow-hidden rounded-full bg-slate-700"
          >
            <span
              className="block h-full bg-sky-500"
              style={{ width: `${String(percent)}%` }}
            />
          </div>
        </div>
      )}

      {isLoading ? (
        <Spinner label="Loading sub-issues" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">This issue has no sub-issues.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((child) => (
            <li
              key={child.id}
              className="flex flex-wrap items-baseline gap-3 rounded-md border border-slate-700 px-3 py-2"
            >
              <Link
                to={`/w/${slug}/issues/${child.key}`}
                className="font-mono text-xs text-sky-400 hover:text-sky-300"
              >
                {child.key}
              </Link>
              <Link
                to={`/w/${slug}/issues/${child.key}`}
                className="text-sm text-slate-100 hover:text-white"
              >
                {child.title}
              </Link>
              <span className="text-xs text-slate-400">
                {statuses.find((status) => status.id === child.status_id)
                  ?.name ?? 'Unknown status'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}
    </section>
  );
};

export default SubIssues;
