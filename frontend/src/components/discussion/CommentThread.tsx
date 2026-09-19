/**
 * One issue's comment thread: the comments oldest first, a composer, and the
 * edit, delete and reply controls each row offers. It is polled rather than
 * held, because a thread is the surface that most visibly goes stale while two
 * people are reading the same issue.
 *
 * Replies are one level deep, which the contract enforces with a 409, so the
 * thread renders roots with their replies nested under them rather than an
 * arbitrary tree.
 */

import React, { useCallback, useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  appendComments,
  createComment,
  deleteComment,
  listComments,
  updateComment,
} from '../../api/discussion';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import { errorMessage } from '../../lib/errors';
import { timestampLabel } from '../../lib/issueDisplay';
import { personLabel } from '../../lib/issuePeople';
import { commentsKey } from '../../lib/queryKeys';
import type { CommentRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Spinner from '../ui/spinner';
import ReactionBar from './ReactionBar';

/** Props for CommentThread: which issue, who is reading, and what they may do. */
export interface CommentThreadProps {
  workspaceId: string;
  issueId: string;
  /** The signed in user, so the thread knows which rows it may edit. */
  currentUserId: string;
  /** Whether the caller may write at all, which a project reader may not. */
  canComment: boolean;
  /** Whether the caller administers the project, who may delete any comment. */
  isAdmin: boolean;
}

/** How many comments one page asks for. */
const PAGE_SIZE = 50;

/** How often the thread is re-read while the issue is open. */
const POLL_MS = 20000;

/** Groups the flat page into roots and the replies hanging off each one. */
const byThread = (
  comments: CommentRead[]
): { root: CommentRead; replies: CommentRead[] }[] => {
  const roots = comments.filter((row) => row.parent_comment_id === null);
  const known = new Set(roots.map((row) => row.comment_id));
  const orphans = comments.filter(
    (row) => row.parent_comment_id !== null && !known.has(row.parent_comment_id)
  );
  return [...roots, ...orphans].map((root) => ({
    root,
    replies: comments.filter(
      (row) => row.parent_comment_id === root.comment_id
    ),
  }));
};

/** Props for one rendered comment row. */
interface CommentRowProps {
  comment: CommentRead;
  workspaceId: string;
  issueId: string;
  currentUserId: string;
  canComment: boolean;
  isAdmin: boolean;
  onReply: (commentId: string) => void;
  canReply: boolean;
}

/** One comment, with its reactions and the controls its reader may use. */
const CommentRow: React.FC<CommentRowProps> = ({
  comment,
  workspaceId,
  issueId,
  currentUserId,
  canComment,
  isAdmin,
  onReply,
  canReply,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const queryKey = commentsKey(issueId);

  const isAuthor = comment.author_id === currentUserId;

  const {
    mutate: save,
    isMutating: isSaving,
    error: saveError,
  } = useMutationWithRefetch(
    (body: string) =>
      updateComment(workspaceId, comment.comment_id, issueId, body),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    () => deleteComment(workspaceId, comment.comment_id, issueId),
    queryKey
  );

  return (
    <article className="space-y-2 rounded-md border border-slate-700 p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-slate-100">
          {personLabel({
            user_id: comment.author.user_id,
            email: comment.author.email,
            display_name: comment.author.display_name,
          })}
        </span>
        <span className="text-xs text-slate-500">
          {timestampLabel(comment.created_at)}
        </span>
        {comment.edited_at !== null && (
          <span className="text-xs text-slate-500">Edited</span>
        )}
      </div>

      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(saveError, 'Could not save that comment.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not delete that comment.')}
        />
      )}

      {editing ? (
        <div className="space-y-2">
          <label htmlFor={`edit-${comment.comment_id}`} className="sr-only">
            Edit comment
          </label>
          <textarea
            id={`edit-${comment.comment_id}`}
            rows={4}
            className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              disabled={isSaving || draft.trim() === ''}
              onClick={() => {
                void save(draft.trim())
                  .then(() => {
                    setEditing(false);
                  })
                  .catch(() => undefined);
              }}
            >
              {isSaving ? 'Saving' : 'Save'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setDraft(comment.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm text-slate-200">
          {comment.body}
        </p>
      )}

      <ReactionBar
        workspaceId={workspaceId}
        targetId={comment.comment_id}
        targetKind="comment"
        reactions={comment.reactions}
        canReact={canComment}
        refetchKey={queryKey}
      />

      {!editing && (
        <div className="flex flex-wrap gap-2">
          {canComment && canReply && (
            <button
              type="button"
              className="text-xs text-sky-400 hover:text-sky-300"
              onClick={() => {
                onReply(comment.comment_id);
              }}
            >
              Reply
            </button>
          )}
          {isAuthor && (
            <button
              type="button"
              className="text-xs text-sky-400 hover:text-sky-300"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {(isAuthor || isAdmin) && (
            <button
              type="button"
              aria-label="Delete comment"
              className="text-xs text-red-300 hover:text-red-200"
              onClick={() => {
                void remove().catch(() => undefined);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </article>
  );
};

/** Reads, pages and writes one issue's comment thread. */
export const CommentThread: React.FC<CommentThreadProps> = ({
  workspaceId,
  issueId,
  currentUserId,
  canComment,
  isAdmin,
}) => {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const queryKey = commentsKey(issueId);

  const read = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<CommentRead>> => {
      const page = await listComments(
        workspaceId,
        issueId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.comments, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );

  const merge = useCallback(
    (held: CommentRead[], incoming: CommentRead[]): CommentRead[] =>
      appendComments(held, incoming),
    []
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, {
      queryKey,
      enabled: workspaceId !== '' && issueId !== '',
      intervalMs: POLL_MS,
    });

  const {
    mutate: post,
    isMutating,
    error: postError,
  } = useMutationWithRefetch(
    (body: string, parent: string | null) =>
      createComment(workspaceId, issueId, {
        body,
        ...(parent === null ? {} : { parent_comment_id: parent }),
      }),
    queryKey
  );

  const threads = byThread(rows);

  return (
    <section className="space-y-3">
      <h3 className="text-base font-medium text-white">Comments</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the comments.')}
        />
      )}
      {postError !== null && (
        <ErrorAlert
          message={errorMessage(postError, 'Could not post that comment.')}
        />
      )}

      {isLoading ? (
        <Spinner label="Loading comments" />
      ) : threads.length === 0 ? (
        <p className="text-sm text-slate-400">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {threads.map(({ root, replies }) => (
            <li key={root.comment_id} className="space-y-2">
              <CommentRow
                comment={root}
                workspaceId={workspaceId}
                issueId={issueId}
                currentUserId={currentUserId}
                canComment={canComment}
                isAdmin={isAdmin}
                onReply={setReplyTo}
                canReply
              />
              {replies.length > 0 && (
                <ul className="ml-6 space-y-2">
                  {replies.map((reply) => (
                    <li key={reply.comment_id}>
                      <CommentRow
                        comment={reply}
                        workspaceId={workspaceId}
                        issueId={issueId}
                        currentUserId={currentUserId}
                        canComment={canComment}
                        isAdmin={isAdmin}
                        onReply={setReplyTo}
                        canReply={false}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      {hasMore && !isLoading && (
        <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}

      {canComment && (
        <div className="space-y-2 rounded-md border border-slate-700 p-4">
          {replyTo !== null && (
            <p className="flex items-center gap-2 text-xs text-slate-400">
              Replying to a comment
              <button
                type="button"
                className="text-sky-400 hover:text-sky-300"
                onClick={() => {
                  setReplyTo(null);
                }}
              >
                Cancel reply
              </button>
            </p>
          )}
          <label htmlFor="new-comment" className="sr-only">
            Write a comment
          </label>
          <textarea
            id="new-comment"
            rows={4}
            placeholder="Write a comment. Mention someone with @."
            className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <Button
            disabled={isMutating || draft.trim() === ''}
            onClick={() => {
              void post(draft.trim(), replyTo)
                .then(() => {
                  setDraft('');
                  setReplyTo(null);
                })
                .catch(() => undefined);
            }}
          >
            {isMutating ? 'Posting' : 'Comment'}
          </Button>
        </div>
      )}
    </section>
  );
};

export default CommentThread;
