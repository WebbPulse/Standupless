/**
 * The anonymous share reader.
 *
 * The route sits outside `ProtectedRoute` and outside `WorkspaceProvider`,
 * because a reader holding a token has neither a session nor a workspace to
 * resolve a slug against. The three reads it makes carry no credential at all,
 * so the page renders identically for a signed-in reader and a signed-out one:
 * if the answer varied with who was asking, a share link would become a way to
 * probe membership.
 *
 * The target is read first, because the token is what decides whether the
 * second read is the one issue or the view listing. A token that does not
 * resolve, has expired or was revoked answers the same 404 in all three cases,
 * so the page says only that the link does not work and offers no way to find
 * out more.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  getSharedIssue,
  getSharedTarget,
  listSharedViewIssues,
} from '../../api/access';
import Button from '../../components/ui/button';
import Spinner from '../../components/ui/spinner';
import { useParams } from 'react-router-dom';
import { dateLabel } from '../../lib/accessDisplay';
import type {
  SharedIssueRead,
  SharedIssueSummaryRead,
  SharedStatusRead,
  SharedTargetRead,
} from '../../types/Api';

/** How many rows one page of a shared view asks for. */
const PAGE_SIZE = 50;

/** What the page is doing, once the first read has settled. */
type LoadState = 'loading' | 'ready' | 'missing';

/** Renders one status as the chip both the issue and the listing use. */
const StatusChip: React.FC<{ status: SharedStatusRead }> = ({ status }) => (
  <span
    className="rounded-full border px-2 py-0.5 text-xs text-slate-200"
    style={{ borderColor: status.color }}
  >
    {status.name}
  </span>
);

/** The state a token that does not resolve lands in, with no detail in it. */
const NotShared: React.FC = () => (
  <main className="mx-auto max-w-3xl space-y-4 px-4 py-12">
    <h1 className="text-2xl font-semibold text-white">Link not found</h1>
    <p className="text-sm text-slate-400">
      This share link does not work. It may have been revoked or it may have
      expired. Ask whoever sent it to you for a new one.
    </p>
  </main>
);

/** Renders the one issue a token resolves to, with its comments. */
const SharedIssuePanel: React.FC<{ issue: SharedIssueRead }> = ({ issue }) => (
  <article className="space-y-6">
    <header className="space-y-2">
      <p className="text-xs text-slate-500">{issue.issue_key}</p>
      <h2 className="text-xl font-semibold text-white">{issue.title}</h2>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={issue.status} />
        {issue.labels.map((label) => (
          <span
            key={label.name}
            className="rounded-full border px-2 py-0.5 text-xs text-slate-200"
            style={{ borderColor: label.color }}
          >
            {label.name}
          </span>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {issue.assignee_name === null
          ? 'Unassigned'
          : `Assigned to ${issue.assignee_name}`}
        , updated {dateLabel(issue.updated_at)}
        {issue.due_date === null ? '' : `, due ${dateLabel(issue.due_date)}`}
      </p>
    </header>

    {issue.body !== null && issue.body !== '' && (
      <p className="whitespace-pre-wrap text-sm text-slate-300">{issue.body}</p>
    )}

    <section className="space-y-3">
      <h3 className="text-sm font-medium text-white">Comments</h3>
      {issue.comments.length === 0 ? (
        <p className="text-sm text-slate-400">There are no comments.</p>
      ) : (
        <ul className="space-y-3">
          {issue.comments.map((comment, index) => (
            <li
              key={`${comment.author_name}-${comment.created_at}-${String(index)}`}
              className="space-y-1 rounded-md border border-slate-700 px-3 py-2"
            >
              <p className="text-xs text-slate-500">
                {comment.author_name}, {dateLabel(comment.created_at)}
              </p>
              <p className="whitespace-pre-wrap text-sm text-slate-300">
                {comment.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  </article>
);

/** Renders the issues a shared view selects, a page at a time. */
const SharedViewPanel: React.FC<{
  issues: SharedIssueSummaryRead[];
  hasMore: boolean;
  isPaging: boolean;
  onLoadMore: () => void;
}> = ({ issues, hasMore, isPaging, onLoadMore }) => (
  <section className="space-y-4">
    {issues.length === 0 ? (
      <p className="text-sm text-slate-400">
        This view has no issues in it right now.
      </p>
    ) : (
      <ul className="space-y-2">
        {issues.map((issue) => (
          <li
            key={issue.issue_key}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-700 px-3 py-2"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-slate-500">{issue.issue_key}</p>
              <p className="truncate text-sm text-slate-100">{issue.title}</p>
              <p className="text-xs text-slate-500">
                {issue.assignee_name === null
                  ? 'Unassigned'
                  : issue.assignee_name}
                , updated {dateLabel(issue.updated_at)}
              </p>
            </div>
            <StatusChip status={issue.status} />
          </li>
        ))}
      </ul>
    )}
    {hasMore && (
      <Button variant="secondary" disabled={isPaging} onClick={onLoadMore}>
        {isPaging ? 'Loading' : 'Load more'}
      </Button>
    )}
  </section>
);

/** Reads a share token and renders the one issue or view it resolves to. */
const SharedView: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const hasToken = token !== '';
  const [state, setState] = useState<LoadState>('loading');
  const [target, setTarget] = useState<SharedTargetRead | null>(null);
  const [issue, setIssue] = useState<SharedIssueRead | null>(null);
  const [rows, setRows] = useState<SharedIssueSummaryRead[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isPaging, setIsPaging] = useState(false);

  useEffect(() => {
    if (!hasToken) return;

    const controller = new AbortController();

    getSharedTarget(token, controller.signal)
      .then(async (resolved) => {
        if (controller.signal.aborted) return;
        setTarget(resolved);
        if (resolved.target_type === 'issue') {
          const body = await getSharedIssue(token, controller.signal);
          if (controller.signal.aborted) return;
          setIssue(body);
        } else {
          const page = await listSharedViewIssues(
            token,
            { limit: PAGE_SIZE },
            controller.signal
          );
          if (controller.signal.aborted) return;
          setRows(page.issues);
          setCursor(page.next_cursor);
        }
        setState('ready');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState('missing');
      });

    return () => {
      controller.abort();
    };
  }, [token, hasToken]);

  const loadMore = useCallback(() => {
    if (cursor === null || isPaging) return;
    setIsPaging(true);
    listSharedViewIssues(token, { cursor, limit: PAGE_SIZE })
      .then((page) => {
        setRows((held) => {
          const seen = new Set(held.map((row) => row.issue_key));
          return [
            ...held,
            ...page.issues.filter((row) => !seen.has(row.issue_key)),
          ];
        });
        setCursor(page.next_cursor);
      })
      .catch(() => undefined)
      .finally(() => {
        setIsPaging(false);
      });
  }, [token, cursor, isPaging]);

  if (hasToken && state === 'loading') {
    return <Spinner label="Opening this share link" />;
  }

  if (!hasToken || state === 'missing' || target === null) {
    return <NotShared />;
  }

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      <header className="space-y-2">
        <p className="text-xs text-slate-500">
          {target.workspace_name}, {target.project_name}
        </p>
        <h1 className="text-2xl font-semibold text-white">{target.title}</h1>
        <p className="text-sm text-slate-400">
          A read-only copy of this {target.target_type}, shared on{' '}
          {dateLabel(target.shared_at)}. It updates as the {target.target_type}{' '}
          changes.
        </p>
      </header>

      {target.target_type === 'issue' ? (
        issue === null ? (
          <NotShared />
        ) : (
          <SharedIssuePanel issue={issue} />
        )
      ) : (
        <SharedViewPanel
          issues={rows}
          hasMore={cursor !== null}
          isPaging={isPaging}
          onLoadMore={loadMore}
        />
      )}
    </main>
  );
};

export default SharedView;
