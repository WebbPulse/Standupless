/**
 * Writes a comment on the same rich Markdown surface as the description:
 * formatting as you type, @mention suggestions from the team's people, and
 * files placed right in the text by the paperclip, by dropping them on the box
 * or by pasting a screenshot. An image or video shows inline behind a progress
 * bar while it uploads and as itself once it lands, and any other file becomes
 * a link to it. Ctrl or Cmd Enter posts.
 *
 * Files upload as soon as they are added and are held out of the issue's rail
 * until the comment posts. Posting links the files the text still names to
 * the comment, and deletes the ones taken back out of it.
 *
 * The editor is its own lazily loaded chunk, so a stand in with the same shape
 * shows until it arrives.
 */

import React, { Suspense, lazy, useCallback, useRef, useState } from 'react';
import {
  invalidateQueries,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { LuArrowUp, LuPaperclip } from 'react-icons/lu';
import { createComment } from '../../api/discussion';
import { useAttachmentUploads } from '../../hooks/useAttachmentUploads';
import { dragHasFiles, filesFrom } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import {
  contentPath,
  embeddedAttachmentIds,
  mediaKindOf,
} from '../../lib/media';
import { rememberPreview, useMedia } from '../../lib/mediaContext';
import { submitKeysLabel } from '../../lib/platform';
import { attachmentsKey, commentsKey } from '../../lib/queryKeys';
import { showErrorToast } from '../../lib/toast';
import { UPLOAD_CONTENT_TYPES } from '../../lib/uploads';
import type { RichMarkdownHandle } from '../editor/RichMarkdownEditor';
import type { UploadFile } from '../editor/mediaNodes';
import Button, { IconButton } from '../ui/button';

const RichMarkdownEditor = lazy(() => import('../editor/RichMarkdownEditor'));

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

/** Posts a comment, with the files its text embeds, to one issue. */
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
  const [inFlight, setInFlight] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const editor = useRef<RichMarkdownHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uploads = useAttachmentUploads(workspaceId, issueId);
  const { upload: sendFile } = uploads;
  const { refresh } = useMedia();

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

  const uploadFile = useCallback<UploadFile>(
    async (file, onProgress) => {
      const attachment = await sendFile(file, onProgress);
      rememberPreview(attachment.attachment_id, file);
      refresh();
      const kind = mediaKindOf(file.type);
      return {
        src: contentPath(workspaceId, attachment.attachment_id, issueId, kind),
        kind,
      };
    },
    [sendFile, refresh, workspaceId, issueId]
  );

  const canPost =
    !isMutating && !inFlight && !uploads.isUploading && draft.trim() !== '';

  const submit = (): void => {
    const body = (editor.current?.getMarkdown() ?? draft).trim();
    if (!canPost || body === '') return;
    const embedded = embeddedAttachmentIds(body);
    const linked = uploads
      .attachmentIds()
      .filter((id) => embedded.includes(id));
    void post(body, linked)
      .then(() => {
        invalidateQueries(attachmentsKey(issueId));
        uploads.settle(linked);
        editor.current?.setMarkdown('');
        onPosted?.();
      })
      .catch((failure: unknown) => {
        showErrorToast(errorMessage(failure, 'Could not post that comment.'));
      });
  };

  const label =
    parentCommentId === undefined ? 'Write a comment' : 'Write a reply';
  const textClass = cn(
    'px-3 text-sm leading-5.5',
    compact ? 'min-h-8 pt-2 pb-1' : 'min-h-16 pt-3 pb-1'
  );

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
      onDropCapture={() => {
        setDragging(false);
      }}
      onDrop={(event) => {
        const files = filesFrom(event.dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        editor.current?.insertFiles(files);
      }}
    >
      <Suspense
        fallback={
          <p className={cn(textClass, 'text-text-faint')}>{placeholder}</p>
        }
      >
        <RichMarkdownEditor
          ref={editor}
          value=""
          editable
          ariaLabel={label}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={textClass}
          density="compact"
          mentionPeople={people}
          uploadFile={uploadFile}
          onCommit={() => false}
          onChange={(markdown, uploading) => {
            setDraft(markdown);
            setInFlight(uploading);
          }}
          onSubmit={submit}
          onFocusChange={setFocused}
          {...(onCancel === undefined ? {} : { onCancel })}
        />
      </Suspense>

      <div className="flex items-center gap-1 px-2 pb-2">
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept={UPLOAD_CONTENT_TYPES.join(',')}
          aria-label="Attach files"
          onChange={(event) => {
            editor.current?.insertFiles(Array.from(event.target.files ?? []));
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
          Paste or drop images and videos
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
