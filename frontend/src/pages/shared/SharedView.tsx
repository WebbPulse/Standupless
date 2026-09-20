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
import Wordmark from '../../components/layout/Wordmark';
import { LabelChip } from '../../components/ui/badge';
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

/** The chrome around every shared page: a wordmark bar and a centred column. */
const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="min-h-screen bg-bg text-text">
    <header className="flex h-topbar items-center border-b border-line px-4 lg:px-6">
      <Wordmark />
    </header>
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8 lg:px-6">
      {children}
    </main>
  </div>
);

/** Renders one status as the chip both the issue and the listing use. */
const StatusChip: React.FC<{ status: SharedStatusRead }> = ({ status }) => (
  <LabelChip color={status.color} name={status.name} />
);

/** The state a token that does not resolve lands in, with no detail in it. */
const NotShared: React.FC = () => (
  <div className="space-y-2">
    <h1 className="text-xl font-semibold">Link not found</h1>
    <p className="text-sm text-text-muted">
      This share link does not work. It may have been revoked or it may have
      expired. Ask whoever sent it to you for a new one.
    </p>
  </div>
);

/** Renders the one issue a token resolves to, with its comments. */
const SharedIssuePanel: React.FC<{ issue: SharedIssueRead }> = ({ issue }) => (
  <article className="space-y-6">
    <header className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-text-faint">
          {issue.issue_key}
        </span>
        <StatusChip status={issue.status} />
        {issue.labels.map((label) => (
          <LabelChip key={label.name} color={label.color} name={label.name} />
        ))}
      </div>
      <h2 className="text-xl font-semibold">{issue.title}</h2>
      <p className="text-xs text-text-muted">
        {issue.assignee_name === null
          ? 'Unassigned'
          : `Assigned to ${issue.assignee_name}`}
        , updated {dateLabel(issue.updated_at)}
        {issue.due_date === null ? '' : `, due ${dateLabel(issue.due_date)}`}
      </p>
    </header>

    {issue.body !== null && issue.body !== '' && (
      <p className="text-sm leading-6 whitespace-pre-wrap text-text">
        {issue.body}
      </p>
    )}

    <section className="space-y-3 border-t border-line pt-6">
      <h3 className="text-base font-semibold">Comments</h3>
      {issue.comments.length === 0 ? (
        <p className="text-sm text-text-muted">There are no comments.</p>
      ) : (
        <ul className="divide-y divide-line">
          {issue.comments.map((comment, index) => (
            <li
              key={`${comment.author_name}-${comment.created_at}-${String(index)}`}
              className="space-y-1 py-3"
            >
              <p className="text-xs text-text-muted">
                <span className="font-medium text-text">
                  {comment.author_name}
                </span>
                , {dateLabel(comment.created_at)}
              </p>
              <p className="text-sm leading-6 whitespace-pre-wrap text-text">
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
      <p className="text-sm text-text-muted">
        This view has no issues in it right now.
      </p>
    ) : (
      <ul className="rounded-md border border-line">
        {issues.map((issue) => (
          <li
            key={issue.issue_key}
            className="flex h-row items-center gap-2.5 border-b border-line px-3 transition-colors duration-100 last:border-b-0 hover:bg-surface"
          >
            <span className="shrink-0 font-mono text-xs text-text-faint">
              {issue.issue_key}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm text-text">
              {issue.title}
            </span>
            <span className="hidden shrink-0 text-xs text-text-muted sm:inline">
              {issue.assignee_name === null
                ? 'Unassigned'
                : issue.assignee_name}
              , updated {dateLabel(issue.updated_at)}
            </span>
            <StatusChip status={issue.status} />
          </li>
        ))}
      </ul>
    )}
    {hasMore && (
      <Button
        variant="ghost"
        size="sm"
        disabled={isPaging}
        onClick={onLoadMore}
      >
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
    return (
      <Frame>
        <Spinner label="Opening this share link" />
      </Frame>
    );
  }

  if (!hasToken || state === 'missing' || target === null) {
    return (
      <Frame>
        <NotShared />
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="space-y-1">
        <p className="text-xs text-text-muted">
          {target.workspace_name}, {target.project_name}
        </p>
        <h1 className="text-xl font-semibold">{target.title}</h1>
        <p className="text-sm text-text-muted">
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
    </Frame>
  );
};

export default SharedView;
