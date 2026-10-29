/**
 * A document's comment thread under its body, on the same cards and composer
 * an issue's timeline uses: replies one level deep, reactions, mentions, edit,
 * delete and resolve. The thread's rows partition under the document id, so
 * the issue id the shared components key on is the document id here.
 *
 * Every page of the thread is read, oldest first, so a long discussion reads
 * whole, and a `#comment-` link scrolls to its comment once it has loaded.
 * A print leaves the thread out and lists its open threads as endnotes.
 * Open threads pinned to a passage are reported to the page's passage
 * threads, so the body highlights what they quote.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { appendComments, listDocumentComments } from '../../api/discussion';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import { usePassageThreads } from '../../contexts/PassageThreadsContextDefinition';
import { anchoredThreads, commentThreads } from '../../lib/issueTimeline';
import { commentsKey } from '../../lib/queryKeys';
import type { CommentRead } from '../../types/Api';
import CommentCard from '../discussion/CommentCard';
import CommentComposer from '../discussion/CommentComposer';
import PrintEndnotes from '../print/PrintEndnotes';
import { ErrorAlert } from '../ui/alert';
import { SkeletonRows } from '../ui/skeleton';

/** How many comments a page holds. */
const PAGE_SIZE = 50;

/** How often the thread re-reads, so someone else's comment appears. */
const POLL_MS = 20000;

/** Props for DocumentThread. */
export interface DocumentThreadProps {
  workspaceId: string;
  documentId: string;
  currentUserId: string;
  /** Whether the reader may comment, which is whether they may edit the document. */
  canComment: boolean;
  /** Whether the reader may delete anyone's comment, as they may delete the document. */
  canModerate: boolean;
  /** The people a mention can name. */
  people: Assignable[];
}

/** Reads a document's comments and renders them as threads with a composer. */
export const DocumentThread: React.FC<DocumentThreadProps> = ({
  workspaceId,
  documentId,
  currentUserId,
  canComment,
  canModerate,
  people,
}) => {
  const headingId = useId();
  const enabled = workspaceId !== '' && documentId !== '';

  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<CommentRead>> => {
      const page = await listDocumentComments(
        workspaceId,
        documentId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.comments, nextCursor: page.next_cursor };
    },
    [workspaceId, documentId]
  );

  const merge = useCallback(
    (held: CommentRead[], incoming: CommentRead[]): CommentRead[] =>
      appendComments(held, incoming),
    []
  );

  const comments = useCursorPages(read, merge, {
    queryKey: commentsKey(documentId),
    enabled,
    intervalMs: POLL_MS,
  });

  const { hasMore, isPaging, isLoading, loadMore } = comments;
  useEffect(() => {
    if (hasMore && !isPaging && !isLoading) loadMore();
  }, [hasMore, isPaging, isLoading, loadMore]);

  const threads = useMemo(() => commentThreads(comments.rows), [comments.rows]);

  const reportThreads = usePassageThreads()?.setThreads;
  useEffect(() => {
    reportThreads?.(anchoredThreads(comments.rows));
  }, [comments.rows, reportThreads]);

  const { hash } = useLocation();
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!hash.startsWith('#comment-') || scrolledTo.current === hash) return;
    const target = document.getElementById(hash.slice(1));
    if (target === null) return;
    scrolledTo.current = hash;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' });
    }
  }, [hash, comments.rows]);

  return (
    <>
      <section
        aria-labelledby={headingId}
        className="screen-only space-y-3 border-t border-line pt-6"
      >
        <h2 id={headingId} className="text-sm font-semibold text-text">
          Comments
        </h2>
        {comments.error !== null && (
          <ErrorAlert
            message={errorMessage(
              comments.error,
              'Could not load the comments.'
            )}
          />
        )}
        {isLoading && comments.rows.length === 0 ? (
          <SkeletonRows label="Loading comments" />
        ) : threads.length === 0 ? (
          <p className="text-xs text-text-faint">No comments yet</p>
        ) : (
          <ol aria-label="Comments" className="space-y-3">
            {threads.map((thread) => (
              <li key={thread.id}>
                <CommentCard
                  comment={thread.comment}
                  replies={thread.replies}
                  people={people}
                  workspaceId={workspaceId}
                  issueId={documentId}
                  documentId={documentId}
                  currentUserId={currentUserId}
                  canComment={canComment}
                  isAdmin={canModerate}
                />
              </li>
            ))}
          </ol>
        )}
        {canComment && (
          <CommentComposer
            workspaceId={workspaceId}
            issueId={documentId}
            documentId={documentId}
            people={people}
          />
        )}
      </section>
      <PrintEndnotes comments={comments.rows} />
    </>
  );
};

export default DocumentThread;
