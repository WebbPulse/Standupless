/**
 * Writes a comment: a textarea that grows with what is typed, @mention
 * autocomplete from the team's people, files attached by the paperclip, by
 * dropping them on the box or by pasting a screenshot, and Ctrl or Cmd Enter to
 * post. Files upload as soon as they are added, so posting only has to name
 * them, and a file removed before posting is deleted from the issue again.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import {
  invalidateQueries,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { LuArrowUp, LuFile, LuImage, LuPaperclip, LuX } from 'react-icons/lu';
import { createComment } from '../../api/discussion';
import { useAttachmentUploads } from '../../hooks/useAttachmentUploads';
import { dragHasFiles, filesFrom } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import {
  insertMention,
  matchPeople,
  mentionHandle,
  mentionQuery,
  type MentionQuery,
} from '../../lib/mentions';
import { submitKeysLabel } from '../../lib/platform';
import { attachmentsKey, commentsKey } from '../../lib/queryKeys';
import { showErrorToast } from '../../lib/toast';
import { UPLOAD_CONTENT_TYPES, sizeLabel } from '../../lib/uploads';
import Avatar from '../ui/avatar';
import Button, { IconButton } from '../ui/button';

/** Props for CommentComposer. */
export interface CommentComposerProps {
  workspaceId: string;
  issueId: string;
  /** The people a mention can name. */
  people: Assignable[];
  /** The root comment this replies to, or undefined for a new thread. */
  parentCommentId?: string;
  /** Called once the comment posted. */
  onPosted?: () => void;
  /** Shows a Cancel button, for a reply box that can be dismissed. */
  onCancel?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** A smaller box, for replies inside a thread. */
  compact?: boolean;
}

/** The tallest the box grows before it scrolls, in px. */
const MAX_HEIGHT = 320;

/** Posts a comment, with its attachments, to one issue. */
export const CommentComposer: React.FC<CommentComposerProps> = ({
  workspaceId,
  issueId,
  people,
  parentCommentId,
  onPosted,
  onCancel,
  autoFocus = false,
  placeholder = 'Leave a comment...',
  compact = false,
}) => {
  const [draft, setDraft] = useState('');
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const listId = useId();
  const uploads = useAttachmentUploads(workspaceId, issueId);

  const { mutate: post, isMutating } = useMutationWithRefetch(
    (body: string, attachmentIds: string[]) =>
      createComment(workspaceId, issueId, {
        body,
        ...(parentCommentId === undefined
          ? {}
          : { parent_comment_id: parentCommentId }),
        ...(attachmentIds.length === 0
          ? {}
          : { attachment_ids: attachmentIds }),
      }),
    commentsKey(issueId)
  );

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    element.style.height = 'auto';
    element.style.height = `${String(Math.min(element.scrollHeight, MAX_HEIGHT))}px`;
    element.style.overflowY =
      element.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden';
  }, [draft]);

  const matches = mention === null ? [] : matchPeople(people, mention.query);
  const listOpen = mention !== null && matches.length > 0;
  const attachmentIds = uploads.attachmentIds();
  const canPost =
    !isMutating &&
    !uploads.isUploading &&
    (draft.trim() !== '' || attachmentIds.length > 0);

  const submit = (): void => {
    if (!canPost) return;
    void post(draft.trim(), attachmentIds)
      .then(() => {
        invalidateQueries(attachmentsKey(issueId));
        setDraft('');
        setMention(null);
        uploads.reset();
        onPosted?.();
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not post that comment.'));
      });
  };

  const readMention = (text: string, caret: number): void => {
    const next = mentionQuery(text, caret);
    setMention(next);
    if (next?.query !== mention?.query) setHighlight(0);
  };

  const choose = (person: Assignable): void => {
    if (mention === null) return;
    const next = insertMention(draft, mention, person);
    setDraft(next.text);
    setMention(null);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (listOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const person = matches[highlight];
        if (person !== undefined) {
          event.preventDefault();
          choose(person);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape' && onCancel !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      className={cn(
        'relative rounded-lg border bg-surface transition-colors duration-100',
        focused ? 'border-line-strong' : 'border-line',
        dragging ? 'border-accent bg-accent-soft/40' : ''
      )}
      onDragOver={(event) => {
        if (!dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDragging(false);
      }}
      onDrop={(event) => {
        const files = filesFrom(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        uploads.add(files);
      }}
    >
      <textarea
        ref={box}
        aria-label={
          parentCommentId === undefined ? 'Write a comment' : 'Write a reply'
        }
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listOpen ? listId : undefined}
        rows={compact ? 1 : 2}
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={draft}
        className={cn(
          'block w-full resize-none bg-transparent px-3 text-sm leading-6 text-text placeholder:text-text-faint focus:outline-none',
          compact ? 'pt-2 pb-1' : 'pt-3 pb-1'
        )}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={() => {
          setFocused(false);
          setTimeout(() => {
            setMention(null);
          }, 150);
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          readMention(event.target.value, event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            readMention(
              event.currentTarget.value,
              event.currentTarget.selectionStart
            );
          }
        }}
        onPaste={(event) => {
          const files = filesFrom(event.clipboardData);
          if (files.length === 0) return;
          event.preventDefault();
          uploads.add(files);
        }}
      />

      {listOpen && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-2 z-20 mb-1 w-64 overflow-hidden rounded-md border border-line bg-overlay py-1 shadow-overlay"
        >
          {matches.map((person, index) => (
            <li
              key={person.user_id}
              role="option"
              aria-selected={index === highlight}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm',
                index === highlight ? 'bg-raised text-text' : 'text-text-muted'
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(person);
              }}
              onMouseEnter={() => {
                setHighlight(index);
              }}
            >
              <Avatar name={personLabel(person)} size="sm" />
              <span className="min-w-0 flex-1 truncate text-text">
                {personLabel(person)}
              </span>
              <span className="shrink-0 text-xs text-text-faint">
                @{mentionHandle(person)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {uploads.pending.length > 0 && (
        <ul
          aria-label="Attached files"
          className="flex flex-wrap gap-1.5 px-3 pb-1"
        >
          {uploads.pending.map((row) => {
            const Icon = row.contentType.startsWith('image/')
              ? LuImage
              : LuFile;
            return (
              <li
                key={row.id}
                className="inline-flex h-7 max-w-60 items-center gap-1.5 rounded-sm border border-line bg-bg pr-1 pl-2 text-xs text-text"
              >
                {row.status === 'uploading' ? (
                  <span
                    role="status"
                    aria-label={`Uploading ${row.name}`}
                    className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-text-muted"
                  />
                ) : (
                  <Icon
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-text-faint"
                  />
                )}
                <span className="min-w-0 truncate">{row.name}</span>
                <span className="shrink-0 text-text-faint">
                  {sizeLabel(row.size)}
                </span>
                <IconButton
                  label={`Remove ${row.name}`}
                  size="sm"
                  className="h-5 w-5"
                  onClick={() => {
                    uploads.remove(row.id);
                  }}
                >
                  <LuX className="h-3 w-3" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-1 px-2 pb-2">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={UPLOAD_CONTENT_TYPES.join(',')}
          aria-label="Attach files"
          onChange={(event) => {
            uploads.add(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        <IconButton
          label="Attach files"
          size="sm"
          onClick={() => {
            picker.current?.click();
          }}
        >
          <LuPaperclip className="h-3.5 w-3.5" />
        </IconButton>
        <span className="hidden text-xs text-text-faint sm:inline">
          Markdown supported
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {onCancel !== undefined && (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <span className="hidden text-2xs text-text-faint sm:inline">
            {submitKeysLabel()}
          </span>
          <Button
            variant={canPost ? 'primary' : 'secondary'}
            size="sm"
            aria-label={parentCommentId === undefined ? 'Comment' : 'Reply'}
            disabled={!canPost}
            className={compact ? '' : 'w-7 px-0'}
            onClick={submit}
          >
            {compact ? (
              isMutating ? (
                'Replying'
              ) : (
                'Reply'
              )
            ) : (
              <LuArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default CommentComposer;
