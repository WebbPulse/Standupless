/**
 * One comment thread as a card in the issue timeline: the root comment, its
 * replies inside the same card, and a reply box at the foot. Each comment shows
 * its author, a relative time, the body as Markdown, what was attached to it
 * and its reactions, with edit and delete in a menu for the people allowed to.
 *
 * Replies are one level deep, which the contract enforces with a 409, so a
 * reply offers no reply of its own and answering one answers the thread.
 */

import React, { useRef, useState } from 'react';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import {
  LuCopy,
  LuEllipsis,
  LuPencil,
  LuReply,
  LuTrash2,
} from 'react-icons/lu';
import { deleteComment, updateComment } from '../../api/discussion';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { submitKeysLabel } from '../../lib/platform';
import { commentsKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { CommentRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';
import Markdown from '../ui/markdown';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import AttachmentList from './AttachmentChips';
import CommentComposer from './CommentComposer';
import ReactionBar from './ReactionBar';

/** What every comment in a card needs to know about its reader. */
interface ReaderProps {
  workspaceId: string;
  issueId: string;
  currentUserId: string;
  canComment: boolean;
  isAdmin: boolean;
}

/** Props for one comment inside a card. */
interface CommentItemProps extends ReaderProps {
  comment: CommentRead;
  /** Opens the thread's reply box, or undefined on a reply. */
  onReply?: () => void;
}

/** The anchor a comment is linked to, so a copied link scrolls to it. */
const anchorOf = (commentId: string): string => `comment-${commentId}`;

/** One comment: header, body, attachments and reactions. */
const CommentItem: React.FC<CommentItemProps> = ({
  comment,
  workspaceId,
  issueId,
  currentUserId,
  canComment,
  isAdmin,
  onReply,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const editor = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(editor);
  const queryKey = commentsKey(issueId);

  const isAuthor = comment.author_id === currentUserId;
  const author = personLabel({
    user_id: comment.author.user_id,
    email: comment.author.email,
    display_name: comment.author.display_name,
  });

  const { mutate: save, isMutating: isSaving } = useMutationWithRefetch(
    (body: string) =>
      updateComment(workspaceId, comment.comment_id, issueId, body),
    queryKey
  );

  const { mutate: remove } = useMutationWithRefetch(
    () => deleteComment(workspaceId, comment.comment_id, issueId),
    queryKey
  );

  const saveDraft = (): void => {
    if (isSaving || draft.trim() === '') return;
    void save(draft.trim())
      .then(() => {
        setEditing(false);
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not save that comment.'));
      });
  };

  const copyLink = (): void => {
    const url = new URL(globalThis.location.href);
    url.hash = anchorOf(comment.comment_id);
    void navigator.clipboard
      .writeText(url.toString())
      .then(() => {
        showToast('Link to the comment copied');
      })
      .catch(() => {
        showErrorToast('Could not copy the link.');
      });
  };

  const attachments = comment.attachments ?? [];
  const canDelete = isAuthor || isAdmin;

  return (
    <article
      id={anchorOf(comment.comment_id)}
      aria-label={`Comment by ${author}`}
      className="group/comment px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <Avatar name={author} size="sm" />
        <span className="truncate text-sm font-medium text-text">{author}</span>
        <RelativeTime value={comment.created_at} />
        {comment.edited_at !== null && (
          <span className="text-xs text-text-faint">(edited)</span>
        )}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100">
          {canComment && onReply !== undefined && (
            <IconButton label="Reply" size="sm" onClick={onReply}>
              <LuReply className="h-3.5 w-3.5" />
            </IconButton>
          )}
          <Menu
            label="Comment actions"
            align="end"
            trigger={(props) => (
              <IconButton label="Comment actions" size="sm" {...props}>
                <LuEllipsis className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <MenuItem onSelect={copyLink}>
              <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
              Copy link
            </MenuItem>
            {isAuthor && (
              <MenuItem
                onSelect={() => {
                  setDraft(comment.body);
                  setEditing(true);
                }}
              >
                <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                Edit
              </MenuItem>
            )}
            {canDelete && (
              <>
                <MenuSeparator />
                <MenuItem
                  danger
                  onSelect={() => {
                    void remove()
                      .then(() => {
                        showToast('Comment deleted');
                      })
                      .catch((failure: unknown) => {
                        showErrorToast(
                          errorMessage(
                            failure,
                            'Could not delete that comment.'
                          )
                        );
                      });
                  }}
                >
                  <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Delete
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </header>

      <div className="mt-1.5 pl-7">
        {editing ? (
          <div className="space-y-2">
            <textarea
              ref={editor}
              aria-label="Edit comment"
              autoFocus
              rows={3}
              value={draft}
              className="block w-full resize-none rounded-md border border-line-strong bg-bg px-3 py-2 text-sm leading-6 text-text focus:outline-none"
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  saveDraft();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(false);
                }
              }}
            />
            <div className="flex items-center justify-end gap-1.5">
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
              <Button
                variant="primary"
                size="sm"
                disabled={isSaving || draft.trim() === ''}
                onClick={saveDraft}
              >
                {isSaving ? 'Saving' : 'Save'}
                <span className="text-2xs opacity-70">{submitKeysLabel()}</span>
              </Button>
            </div>
          </div>
        ) : (
          comment.body !== '' && <Markdown source={comment.body} />
        )}

        {attachments.length > 0 && (
          <AttachmentList
            attachments={attachments}
            workspaceId={workspaceId}
            className="mt-2"
          />
        )}

        {(comment.reactions.length > 0 || canComment) && (
          <div
            className={cn(
              'mt-2',
              comment.reactions.length === 0
                ? 'hidden group-focus-within/comment:block group-hover/comment:block'
                : ''
            )}
          >
            <ReactionBar
              workspaceId={workspaceId}
              targetId={comment.comment_id}
              targetKind="comment"
              reactions={comment.reactions}
              canReact={canComment}
              refetchKey={commentsKey(issueId)}
            />
          </div>
        )}
      </div>
    </article>
  );
};

/** Props for CommentCard: the thread and who is reading it. */
export interface CommentCardProps extends ReaderProps {
  comment: CommentRead;
  replies: CommentRead[];
  people: Assignable[];
}

/** A thread: the root, its replies, and the reply box. */
export const CommentCard: React.FC<CommentCardProps> = ({
  comment,
  replies,
  people,
  ...reader
}) => {
  const [replying, setReplying] = useState(false);
  const openReply = (): void => {
    setReplying(true);
  };

  return (
    <div className="rounded-lg border border-line bg-surface">
      <CommentItem comment={comment} onReply={openReply} {...reader} />
      {replies.map((reply) => (
        <div key={reply.comment_id} className="border-t border-line">
          <CommentItem comment={reply} onReply={openReply} {...reader} />
        </div>
      ))}
      {reader.canComment &&
        (replying ? (
          <div className="border-t border-line p-2">
            <CommentComposer
              workspaceId={reader.workspaceId}
              issueId={reader.issueId}
              people={people}
              parentCommentId={comment.comment_id}
              placeholder="Leave a reply..."
              autoFocus
              compact
              onPosted={() => {
                setReplying(false);
              }}
              onCancel={() => {
                setReplying(false);
              }}
            />
          </div>
        ) : (
          replies.length > 0 && (
            <button
              type="button"
              className="flex w-full items-center gap-2 border-t border-line px-4 py-2 text-left text-sm text-text-faint transition-colors duration-100 hover:text-text-muted"
              onClick={openReply}
            >
              Leave a reply...
            </button>
          )
        ))}
    </div>
  );
};

export default CommentCard;
