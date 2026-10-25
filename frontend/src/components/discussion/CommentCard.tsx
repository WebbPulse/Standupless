/**
 * One comment thread as a card in the issue timeline: the root comment, its
 * replies inside the same card, and a reply box at the foot. Each comment shows
 * its author, a relative time, the body as Markdown, what was attached to it
 * and its reactions, with edit and delete in a menu for the people allowed to.
 *
 * Replies are one level deep, which the contract enforces with a 409, so a
 * reply offers no reply of its own and answering one answers the thread.
 *
 * Editing a comment happens on the same rich surface it was written on. Files a
 * comment embeds in its text show there, so they are not repeated in the
 * attachment row under it.
 *
 * Hovering a comment only fades its actions in, and never changes its layout:
 * with no reactions yet, the add-reaction button sits among those actions
 * rather than in a row under the body that would appear and push the thread.
 *
 * A thread can be synced to a pull request or GitHub issue linked to the issue
 * from its root's menu. A synced root wears a GitHub badge linking to the
 * mirrored comment, and its menu offers to open it there or to unsync, which
 * stops mirroring and leaves what was already copied on both sides.
 *
 * Any member may resolve a thread from its root's menu. A resolved thread
 * collapses to one line naming who resolved it, which expands on click to the
 * whole thread with a way to unresolve it. Replying reopens a thread, which the
 * server does, so the card only follows what the thread list says.
 *
 * On an issue, a comment's menu offers a new sub-issue of the issue described
 * by the comment with a link back to it, and a passage selected in a comment
 * files sub-issues the way a selection in the description does: one per item
 * of a list, or one through the create dialog.
 *
 * Any comment can be quoted into the thread's reply, whole from its menu or a
 * selected passage of it from the Quote button that floats under the
 * selection. The quote lands as a blockquote after whatever the reply already
 * says, with the caret on a new line under it.
 *
 * A thread pinned to a passage of the description opens with that passage.
 * Pressing it scrolls to the highlight in the description, and when the
 * description no longer holds the text the thread says so and keeps the quote.
 *
 * Given a `documentId`, the card is a thread on that document: every write goes
 * through the document's routes, `issueId` names the document so the thread
 * list's key is shared, and GitHub sync and the activity feed play no part.
 */

import React, { Suspense, lazy, useContext, useRef, useState } from 'react';
import {
  invalidateQueries,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  LuChevronDown,
  LuChevronRight,
  LuCircleCheck,
  LuCircleDot,
  LuCopy,
  LuEllipsis,
  LuExternalLink,
  LuGithub,
  LuListTree,
  LuPencil,
  LuReply,
  LuTextQuote,
  LuTrash2,
  LuUnlink,
} from 'react-icons/lu';
import {
  deleteComment,
  deleteDocumentComment,
  resolveThread,
  setDocumentThreadResolved,
  unresolveThread,
  updateComment,
  updateDocumentComment,
} from '../../api/discussion';
import { syncThread, unsyncThread } from '../../api/integrations';
import { useQuoteRequest } from '../../hooks/useQuoteRequest';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { usePassageThreads } from '../../contexts/PassageThreadsContextDefinition';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import {
  actorLabel,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { embeddedAttachmentIds } from '../../lib/media';
import { submitKeysLabel } from '../../lib/platform';
import { quoteMarkdown } from '../../lib/quote';
import { issuePath } from '../../lib/paths';
import { activityKey, childrenKey, commentsKey } from '../../lib/queryKeys';
import {
  createSubIssues,
  resolveSubIssueParent,
  subIssueDialogPresets,
  type ResolvedSubIssueParent,
} from '../../lib/subIssueCreation';
import {
  commentSubIssueBody,
  listTitles,
  textPrefill,
} from '../../lib/subIssueLines';
import {
  PUBLIC_THREAD_WARNING,
  targetKey,
  threadRef,
  threadUrl,
} from '../../lib/threadSync';
import { commentExcerpt, replyCountLabel } from '../../lib/threadResolution';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  CommentAnchor,
  CommentRead,
  GithubThreadTargetRead,
} from '../../types/Api';
import type { RichMarkdownHandle } from '../editor/RichMarkdownEditor';
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';
import Markdown from '../ui/markdown';
import Menu, { MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import ViaSource from '../ui/via-source';
import MemberLink from '../members/MemberLink';
import AttachmentList from './AttachmentChips';
import CommentComposer from './CommentComposer';
import ReactionBar from './ReactionBar';
import SelectionQuote from './SelectionQuote';

const RichMarkdownEditor = lazy(() => import('../editor/RichMarkdownEditor'));

/** What every comment in a card needs to know about its reader. */
interface ReaderProps {
  workspaceId: string;
  issueId: string;
  currentUserId: string;
  canComment: boolean;
  isAdmin: boolean;
  /** Where a thread may be synced on GitHub; empty offers no sync. */
  threadTargets?: GithubThreadTargetRead[];
  /** The document the thread sits on, in place of an issue. */
  documentId?: string;
}

/** Props for one comment inside a card. */
interface CommentItemProps extends ReaderProps {
  comment: CommentRead;
  /** The people an edit can mention. */
  people: Assignable[];
  /** Opens the thread's reply box, or undefined on a reply. */
  onReply?: () => void;
  /** Resolves or reopens the thread, on its root alone. */
  onToggleResolved?: () => void;
  /** Quotes a passage, as a Markdown blockquote, into the thread's reply. */
  onQuote?: (markdown: string) => void;
}

/** The anchor a comment is linked to, so a copied link scrolls to it. */
const anchorOf = (commentId: string): string => `comment-${commentId}`;

/**
 * The address of a comment on its issue's page, or on the page showing it when
 * the workspace is not known.
 */
const commentUrl = (
  commentId: string,
  slug: string | undefined,
  issueKey: string
): string => {
  const url = new URL(globalThis.location.href);
  if (slug !== undefined) {
    url.pathname = issuePath(slug, issueKey);
    url.search = '';
  }
  url.hash = anchorOf(commentId);
  return url.toString();
};

/** Props for PassageQuote. */
interface PassageQuoteProps {
  anchor: CommentAnchor;
  /** Whether the description still holds the passage; unknown counts as held. */
  held: boolean;
  /** Scrolls to the passage, or undefined when there is none to scroll to. */
  onShow?: (() => void) | undefined;
}

/** The passage of the description a thread is pinned to, at the top of its card. */
const PassageQuote: React.FC<PassageQuoteProps> = ({
  anchor,
  held,
  onShow,
}) => {
  const text = (
    <span className="line-clamp-3 border-l-2 border-warning/60 pl-2 text-left whitespace-pre-line">
      {anchor.quote}
    </span>
  );
  return (
    <div className="space-y-1 border-b border-line px-4 py-2 text-xs text-text-muted">
      {held && onShow !== undefined ? (
        <button
          type="button"
          aria-label="Show the passage in the description"
          className="block w-full rounded-sm transition-colors duration-100 hover:text-text"
          onClick={onShow}
        >
          {text}
        </button>
      ) : (
        <p>{text}</p>
      )}
      {!held && (
        <p className="text-2xs text-text-faint">
          The description no longer has this text.
        </p>
      )}
    </div>
  );
};

/** One comment: header, body, attachments and reactions. */
const CommentItem: React.FC<CommentItemProps> = ({
  comment,
  people,
  workspaceId,
  issueId,
  currentUserId,
  canComment,
  isAdmin,
  threadTargets = [],
  documentId,
  onReply,
  onToggleResolved,
  onQuote,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const editor = useRef<RichMarkdownHandle>(null);
  const queryKey = commentsKey(issueId);

  const isAuthor = comment.author_id === currentUserId;
  const author = personLabel({
    user_id: comment.author.user_id,
    email: comment.author.email,
    display_name: comment.author.display_name,
  });

  const { mutate: save, isMutating: isSaving } = useMutationWithRefetch(
    (body: string) =>
      documentId !== undefined
        ? updateDocumentComment(
            workspaceId,
            documentId,
            comment.comment_id,
            body
          )
        : updateComment(workspaceId, comment.comment_id, issueId, body),
    queryKey
  );

  const { mutate: remove } = useMutationWithRefetch(
    () =>
      documentId !== undefined
        ? deleteDocumentComment(workspaceId, documentId, comment.comment_id)
        : deleteComment(workspaceId, comment.comment_id, issueId),
    queryKey
  );

  const { mutate: sync } = useMutationWithRefetch(
    (target: GithubThreadTargetRead) =>
      syncThread(workspaceId, issueId, comment.comment_id, {
        repository_id: target.repository_id,
        number: target.number,
      }),
    queryKey
  );

  const { mutate: unsync } = useMutationWithRefetch(
    () => unsyncThread(workspaceId, issueId, comment.comment_id),
    queryKey
  );

  const syncTo = (target: GithubThreadTargetRead): void => {
    void sync(target)
      .then(() => {
        showToast(
          target.private
            ? `Thread synced to ${target.ref}`
            : `Thread synced to ${target.ref}. ${PUBLIC_THREAD_WARNING}`
        );
      })
      .catch((failure: unknown) => {
        showErrorToast(
          errorMessage(failure, 'Could not sync that thread to GitHub.')
        );
      });
  };

  const stopSync = (): void => {
    void unsync()
      .then(() => {
        showToast('Thread no longer syncs to GitHub');
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not unsync that thread.'));
      });
  };

  const saveDraft = (): void => {
    const body = (editor.current?.getMarkdown() ?? draft).trim();
    if (isSaving || body === '') return;
    void save(body)
      .then(() => {
        setEditing(false);
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not save that comment.'));
      });
  };

  const issueCreator = useCreateIssue();
  const slug = useContext(WorkspaceContext)?.workspace?.slug;
  const canSubIssue =
    canComment && documentId === undefined && issueCreator.canCreate;

  const openSubIssue = (
    draft: (parent: ResolvedSubIssueParent) => {
      title?: string;
      description?: string;
    }
  ): void => {
    void resolveSubIssueParent(workspaceId, { id: issueId })
      .then((parent) => {
        issueCreator.open({
          ...subIssueDialogPresets(parent),
          ...draft(parent),
          onCreated: () => {
            invalidateQueries([childrenKey(issueId), activityKey(issueId)]);
          },
        });
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not read the issue.'));
      });
  };

  const subIssuesFromPassage = (markdown: string): void => {
    const titles = listTitles(markdown);
    if (titles !== null && titles.length >= 2) {
      void createSubIssues(
        workspaceId,
        { id: issueId },
        titles.map((title) => ({ title }))
      );
      return;
    }
    const prefill = textPrefill(markdown);
    if (prefill.title === '') return;
    openSubIssue(() => ({
      title: prefill.title,
      ...(prefill.description === ''
        ? {}
        : { description: prefill.description }),
    }));
  };

  const subIssueFromComment = (): void => {
    openSubIssue((parent) => ({
      description: commentSubIssueBody(
        comment.body,
        commentUrl(comment.comment_id, slug, parent.key)
      ),
    }));
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

  const embedded = embeddedAttachmentIds(comment.body);
  const attachments = (comment.attachments ?? []).filter(
    (attachment) => !embedded.includes(attachment.attachment_id)
  );
  const hasReactions = comment.reactions.some((group) => group.count > 0);
  const canDelete = isAuthor || isAdmin;
  const isRoot = comment.parent_comment_id === null;
  const thread = isRoot ? (comment.github_thread ?? null) : null;
  const canSync =
    isRoot && canComment && thread === null && documentId === undefined;
  const isResolved = isRoot && (comment.resolution ?? null) !== null;
  const quote = canComment ? onQuote : undefined;
  const quoted = quoteMarkdown(comment.body);

  return (
    <article
      id={anchorOf(comment.comment_id)}
      tabIndex={-1}
      aria-label={`Comment by ${author}`}
      className="group/comment px-4 py-3 outline-none"
    >
      <header className="flex items-center gap-2">
        <MemberLink
          userId={comment.author.user_id}
          className="flex min-w-0 items-center gap-2"
        >
          <Avatar name={author} src={comment.author.avatar_url} size="sm" />
          <span className="truncate text-sm font-medium text-text">
            {author}
          </span>
        </MemberLink>
        <RelativeTime value={comment.created_at} />
        <ViaSource source={comment.source} />
        {comment.edited_at !== null && (
          <span className="text-xs text-text-faint">(edited)</span>
        )}
        {thread !== null && (
          <a
            href={threadUrl(thread)}
            target="_blank"
            rel="noreferrer"
            title={`Synced to ${threadRef(thread)}`}
            aria-label={`Synced to ${threadRef(thread)} on GitHub`}
            className="inline-flex items-center gap-1 rounded-sm px-1 text-xs text-text-faint transition-colors duration-100 hover:text-text"
          >
            <LuGithub aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{threadRef(thread)}</span>
          </a>
        )}
        <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity duration-100 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 pointer-coarse:opacity-100">
          {canComment && !hasReactions && (
            <ReactionBar
              workspaceId={workspaceId}
              targetId={comment.comment_id}
              targetKind="comment"
              issueId={issueId}
              {...(documentId === undefined ? {} : { documentId })}
              reactions={[]}
              canReact
              refetchKey={commentsKey(issueId)}
            />
          )}
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
            {quote !== undefined && quoted !== '' && (
              <MenuItem
                onSelect={() => {
                  quote(quoted);
                }}
              >
                <LuTextQuote aria-hidden="true" className="h-3.5 w-3.5" />
                Quote in reply
              </MenuItem>
            )}
            {canSubIssue && (
              <MenuItem onSelect={subIssueFromComment}>
                <LuListTree aria-hidden="true" className="h-3.5 w-3.5" />
                New sub-issue from comment
              </MenuItem>
            )}
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
            {isRoot && canComment && onToggleResolved !== undefined && (
              <MenuItem onSelect={onToggleResolved}>
                {isResolved ? (
                  <LuCircleDot aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <LuCircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {isResolved ? 'Unresolve thread' : 'Resolve thread'}
              </MenuItem>
            )}
            {thread !== null && (
              <>
                <MenuSeparator />
                <MenuItem
                  onSelect={() => {
                    globalThis.open(threadUrl(thread), '_blank', 'noreferrer');
                  }}
                >
                  <LuExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                  Open on GitHub
                </MenuItem>
                {canComment && (
                  <MenuItem onSelect={stopSync}>
                    <LuUnlink aria-hidden="true" className="h-3.5 w-3.5" />
                    Unsync from GitHub
                  </MenuItem>
                )}
              </>
            )}
            {canSync && threadTargets.length > 0 && (
              <>
                <MenuSeparator />
                <MenuLabel>Sync thread to GitHub</MenuLabel>
                {threadTargets.map((target) => (
                  <MenuItem
                    key={targetKey(target)}
                    textValue={`Sync thread to GitHub ${target.ref} ${target.title}`}
                    onSelect={() => {
                      syncTo(target);
                    }}
                  >
                    <LuGithub aria-hidden="true" className="h-3.5 w-3.5" />
                    <span className="truncate">{target.ref}</span>
                    {!target.private && (
                      <span className="ml-auto text-2xs text-text-faint">
                        Public
                      </span>
                    )}
                  </MenuItem>
                ))}
              </>
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
            <Suspense
              fallback={<Markdown source={comment.body} density="compact" />}
            >
              <RichMarkdownEditor
                ref={editor}
                value={comment.body}
                editable
                autoFocus
                ariaLabel="Edit comment"
                mentionPeople={people}
                className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm leading-5.5"
                density="compact"
                onCommit={() => false}
                onChange={(markdown) => {
                  setDraft(markdown);
                }}
                onSubmit={saveDraft}
                onCancel={() => {
                  setEditing(false);
                }}
                selectionIssue={
                  documentId === undefined
                    ? { issueId, parent: { id: issueId } }
                    : { issueId }
                }
              />
            </Suspense>
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
          comment.body !== '' && (
            <SelectionQuote
              onQuote={quote}
              {...(canSubIssue ? { onSubIssue: subIssuesFromPassage } : {})}
            >
              <Markdown source={comment.body} density="compact" />
            </SelectionQuote>
          )
        )}

        {attachments.length > 0 && (
          <AttachmentList
            attachments={attachments}
            workspaceId={workspaceId}
            className="mt-2"
          />
        )}

        {hasReactions && (
          <div className="mt-2">
            <ReactionBar
              workspaceId={workspaceId}
              targetId={comment.comment_id}
              targetKind="comment"
              issueId={issueId}
              {...(documentId === undefined ? {} : { documentId })}
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
  const [expanded, setExpanded] = useState(false);
  const quotes = useQuoteRequest();
  const passages = usePassageThreads();
  const queryKey = commentsKey(reader.issueId);
  const resolution = comment.resolution ?? null;
  const anchor = comment.anchor ?? null;
  const commentId = comment.comment_id;
  const located = passages?.located ?? null;
  const held =
    resolution !== null || located === null || located.has(commentId);
  const active = passages !== null && passages.activeId === commentId;

  const { documentId } = reader;
  const refreshActivity = (): void => {
    if (documentId === undefined) {
      invalidateQueries([activityKey(reader.issueId)]);
    }
  };

  const { mutate: resolve } = useMutationWithRefetch(
    () =>
      documentId !== undefined
        ? setDocumentThreadResolved(
            reader.workspaceId,
            documentId,
            comment.comment_id,
            true
          )
        : resolveThread(reader.workspaceId, reader.issueId, comment.comment_id),
    queryKey
  );

  const { mutate: unresolve } = useMutationWithRefetch(
    () =>
      documentId !== undefined
        ? setDocumentThreadResolved(
            reader.workspaceId,
            documentId,
            comment.comment_id,
            false
          )
        : unresolveThread(
            reader.workspaceId,
            reader.issueId,
            comment.comment_id
          ),
    queryKey
  );

  const openReply = (): void => {
    setReplying(true);
  };

  const quoteInReply = (markdown: string): void => {
    setReplying(true);
    quotes.ask(markdown);
  };

  const markResolved = (): void => {
    void resolve()
      .then(() => {
        setExpanded(false);
        setReplying(false);
        quotes.clear();
        refreshActivity();
        showToast('Thread resolved');
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not resolve that thread.'));
      });
  };

  const markOpen = (): void => {
    void unresolve()
      .then(() => {
        refreshActivity();
        showToast('Thread reopened');
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not reopen that thread.'));
      });
  };

  const author = personLabel({
    user_id: comment.author.user_id,
    email: comment.author.email,
    display_name: comment.author.display_name,
  });

  if (resolution !== null && !expanded) {
    const resolver = actorLabel('user', resolution.resolved_by, people);
    const excerpt = commentExcerpt(comment.body);
    const count = replyCountLabel(replies.length);
    return (
      <div
        id={`comment-${comment.comment_id}`}
        className="rounded-lg border border-line bg-surface"
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label={`Resolved thread by ${author}, resolved by ${resolver}. Show thread`}
          className="flex w-full min-w-0 items-center gap-2 rounded-lg px-4 py-2 text-left text-sm text-text-muted transition-colors duration-100 hover:bg-raised hover:text-text"
          onClick={() => {
            setExpanded(true);
          }}
        >
          <LuChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
          />
          <Avatar name={author} src={comment.author.avatar_url} size="xs" />
          <span className="shrink-0 font-medium text-text">{author}</span>
          {excerpt !== '' && (
            <span className="min-w-0 truncate text-text-muted">{excerpt}</span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-text-faint">
            {count !== '' && <span>{count}</span>}
            {count !== '' && <span aria-hidden="true">·</span>}
            <LuCircleCheck
              aria-hidden="true"
              className="h-3.5 w-3.5 text-success"
            />
            <span className="hidden sm:inline">Resolved by {resolver}</span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-surface transition-colors duration-150',
        active ? 'border-warning/70' : 'border-line'
      )}
    >
      {resolution !== null && (
        <div className="flex items-center gap-2 border-b border-line px-4 py-1.5 text-xs text-text-faint">
          <LuCircleCheck
            aria-hidden="true"
            className="h-3.5 w-3.5 text-success"
          />
          <span className="min-w-0 truncate">
            Resolved by {actorLabel('user', resolution.resolved_by, people)}
          </span>
          <RelativeTime value={resolution.resolved_at} />
          <div className="ml-auto flex items-center gap-1">
            {reader.canComment && (
              <Button variant="ghost" size="sm" onClick={markOpen}>
                Unresolve
              </Button>
            )}
            <IconButton
              label="Collapse thread"
              size="sm"
              aria-expanded
              onClick={() => {
                setExpanded(false);
              }}
            >
              <LuChevronDown className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        </div>
      )}
      {anchor !== null && (
        <PassageQuote
          anchor={anchor}
          held={held}
          onShow={
            passages === null || resolution !== null
              ? undefined
              : () => {
                  passages.showPassage(commentId);
                }
          }
        />
      )}
      <CommentItem
        comment={comment}
        people={people}
        onReply={openReply}
        onQuote={quoteInReply}
        onToggleResolved={resolution !== null ? markOpen : markResolved}
        {...reader}
      />
      {replies.map((reply) => (
        <div key={reply.comment_id} className="border-t border-line">
          <CommentItem
            comment={reply}
            people={people}
            onReply={openReply}
            onQuote={quoteInReply}
            {...reader}
          />
        </div>
      ))}
      {reader.canComment &&
        (replying ? (
          <div className="border-t border-line p-2">
            <CommentComposer
              workspaceId={reader.workspaceId}
              issueId={reader.issueId}
              {...(documentId === undefined ? {} : { documentId })}
              people={people}
              parentCommentId={comment.comment_id}
              placeholder="Leave a reply..."
              autoFocus
              compact
              quote={quotes.request}
              onPosted={() => {
                setReplying(false);
                quotes.clear();
                if (resolution !== null) refreshActivity();
              }}
              onCancel={() => {
                setReplying(false);
                quotes.clear();
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
