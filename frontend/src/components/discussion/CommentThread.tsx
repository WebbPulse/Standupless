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
import { LuX } from 'react-icons/lu';
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
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import Spinner from '../ui/spinner';
import ReactionBar from './ReactionBar';

/** Props for CommentThread: which issue, who is reading, and what they may do. */
export interface CommentThreadProps {
  workspaceId: string;
  issueId: string;
  /** The signed in user, so the thread knows which rows it may edit. */
  currentUserId: string;
  /** Whether the caller may write at all, which a team reader may not. */
  canComment: boolean;
  /** Whether the caller administers the team, who may delete any comment. */
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
  const author = personLabel({
    user_id: comment.author.user_id,
    email: comment.author.email,
    display_name: comment.author.display_name,
  });

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
    <article className="flex gap-3">
      <Avatar name={author} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-text">{author}</span>
          <span className="text-xs text-text-muted">
            {timestampLabel(comment.created_at)}
          </span>
          {comment.edited_at !== null && (
            <span className="text-xs text-text-faint">Edited</span>
          )}
        </div>

        {saveError !== null && (
          <ErrorAlert
            message={errorMessage(saveError, 'Could not save that comment.')}
          />
        )}
        {removeError !== null && (
          <ErrorAlert
            message={errorMessage(
              removeError,
              'Could not delete that comment.'
            )}
          />
        )}

        {editing ? (
          <div className="space-y-2">
            <Label htmlFor={`edit-${comment.comment_id}`} hidden>
              Edit comment
            </Label>
            <Textarea
              id={`edit-${comment.comment_id}`}
              rows={4}
              autoFocus
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
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
                variant="ghost"
                size="sm"
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
          <p className="text-sm leading-6 whitespace-pre-wrap text-text">
            {comment.body}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ReactionBar
            workspaceId={workspaceId}
            targetId={comment.comment_id}
            targetKind="comment"
            reactions={comment.reactions}
            canReact={canComment}
            refetchKey={queryKey}
          />

          {!editing && (
            <div className="flex items-center gap-0.5">
              {canComment && canReply && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onReply(comment.comment_id);
                  }}
                >
                  Reply
                </Button>
              )}
              {isAuthor && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(comment.body);
                    setEditing(true);
                  }}
                >
                  Edit
                </Button>
              )}
              {(isAuthor || isAdmin) && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Delete comment"
                  className="hover:text-danger"
                  onClick={() => {
                    void remove().catch(() => undefined);
                  }}
                >
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
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
    <section className="space-y-4">
      <h3 className="text-base font-semibold">Comments</h3>

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
        <p className="text-sm text-text-muted">No comments yet.</p>
      ) : (
        <ul className="space-y-6">
          {threads.map(({ root, replies }) => (
            <li key={root.comment_id} className="space-y-4">
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
                <ul className="ml-10 space-y-4 border-l border-line pl-4">
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
        <Button
          variant="ghost"
          size="sm"
          disabled={isPaging}
          onClick={loadMore}
        >
          {isPaging ? 'Loading' : 'Load more'}
        </Button>
      )}

      {canComment && (
        <div className="space-y-2 rounded-md border border-line bg-surface p-3">
          {replyTo !== null && (
            <p className="flex items-center gap-1 text-xs text-text-muted">
              Replying to a comment
              <IconButton
                label="Cancel reply"
                size="sm"
                onClick={() => {
                  setReplyTo(null);
                }}
              >
                <LuX className="h-3.5 w-3.5" />
              </IconButton>
            </p>
          )}
          <Label htmlFor="new-comment" hidden>
            Write a comment
          </Label>
          <Textarea
            id="new-comment"
            rows={4}
            placeholder="Write a comment. Mention someone with @."
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
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
        </div>
      )}
    </section>
  );
};

export default CommentThread;
