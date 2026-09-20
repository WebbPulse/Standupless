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
import { StatusGlyph } from '../ui/glyphs';
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
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Sub-issues</h3>
        {progress.total > 0 && (
          <div className="flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="Sub-issue progress"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-24 overflow-hidden rounded-full bg-raised"
            >
              <span
                className="block h-full bg-accent"
                style={{ width: `${String(percent)}%` }}
              />
            </div>
            <p className="text-xs text-text-muted">
              {progress.completed} of {progress.total} done
            </p>
          </div>
        )}
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the sub-issues.')}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading sub-issues" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-text-muted">This issue has no sub-issues.</p>
      ) : (
        <ul className="rounded-md border border-line">
          {rows.map((child) => {
            const status = statuses.find(
              (candidate) => candidate.id === child.status_id
            );
            return (
              <li
                key={child.id}
                className="flex h-row items-center gap-2.5 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
              >
                <StatusGlyph
                  category={status?.category}
                  {...(status === undefined ? {} : { name: status.name })}
                />
                <Link
                  to={`/w/${slug}/issues/${child.key}`}
                  className="shrink-0 rounded-xs font-mono text-xs text-text-faint hover:text-text"
                >
                  {child.key}
                </Link>
                <Link
                  to={`/w/${slug}/issues/${child.key}`}
                  className="min-w-0 flex-1 truncate rounded-xs text-sm text-text hover:underline"
                >
                  {child.title}
                </Link>
                <span className="shrink-0 text-xs text-text-muted">
                  {status?.name ?? 'Unknown status'}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button
          variant="ghost"
          size="sm"
          disabled={isPaging}
          onClick={loadMore}
        >
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}
    </section>
  );
};

export default SubIssues;
