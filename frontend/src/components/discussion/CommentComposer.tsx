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
 *
 * A new thread on an issue with a linked pull request or GitHub issue can be
 * synced as it posts. The toggle picks the one target, or opens a picker when
 * there are several, and a public repository carries a warning, because the
 * thread is published there.
 */

import React, { Suspense, lazy, useCallback, useRef, useState } from 'react';
import {
  invalidateQueries,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import { LuArrowUp, LuCheck, LuGithub, LuPaperclip } from 'react-icons/lu';
import { createComment } from '../../api/discussion';
import { syncThread } from '../../api/integrations';
import { useAttachmentUploads } from '../../hooks/useAttachmentUploads';
import { useCommentDraft } from '../../hooks/useCommentDraft';
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
import { PUBLIC_THREAD_WARNING, targetKey } from '../../lib/threadSync';
import { showErrorToast } from '../../lib/toast';
import { UPLOAD_CONTENT_TYPES } from '../../lib/uploads';
import type { GithubThreadTargetRead } from '../../types/Api';
import type { RichMarkdownHandle } from '../editor/RichMarkdownEditor';
import type { UploadFile } from '../editor/mediaNodes';
import Button, { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';

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
  /** Where a new thread may be synced on GitHub; empty offers no sync. */
  threadTargets?: GithubThreadTargetRead[];
}

/** Props for ThreadSyncToggle. */
interface ThreadSyncToggleProps {
  targets: GithubThreadTargetRead[];
  chosen: GithubThreadTargetRead | null;
  onChoose: (target: GithubThreadTargetRead | null) => void;
}

/** Turns syncing a new thread on or off, with a picker when there are several targets. */
const ThreadSyncToggle: React.FC<ThreadSyncToggleProps> = ({
  targets,
  chosen,
  onChoose,
}) => {
  const label = chosen === null ? 'Sync to GitHub' : `Syncing to ${chosen.ref}`;
  const toggleClass = cn(chosen === null ? '' : 'text-accent');
  const [only] = targets;
  if (targets.length === 1 && only !== undefined) {
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={chosen !== null}
        title={`Sync this thread to ${only.ref}`}
        className={toggleClass}
        onClick={() => {
          onChoose(chosen === null ? only : null);
        }}
      >
        <LuGithub aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{label}</span>
      </Button>
    );
  }
  return (
    <Menu
      label="Sync thread to GitHub"
      trigger={(props) => (
        <Button
          variant="ghost"
          size="sm"
          className={toggleClass}
          aria-label={label}
          {...props}
        >
          <LuGithub aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </Button>
      )}
    >
      <MenuLabel>Sync thread to</MenuLabel>
      {targets.map((target) => (
        <MenuItem
          key={targetKey(target)}
          textValue={`${target.ref} ${target.title}`}
          onSelect={() => {
            onChoose(target);
          }}
        >
          <LuCheck
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5',
              chosen !== null && targetKey(chosen) === targetKey(target)
                ? ''
                : 'invisible'
            )}
          />
          <span className="truncate">
            {target.ref}
            {target.title === '' ? '' : ` ${target.title}`}
          </span>
          {!target.private && (
            <span className="ml-auto text-2xs text-text-faint">Public</span>
          )}
        </MenuItem>
      ))}
      {chosen !== null && (
        <>
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              onChoose(null);
            }}
          >
            Do not sync
          </MenuItem>
        </>
      )}
    </Menu>
  );
};

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
  threadTargets = [],
}) => {
  const [draft, setDraft] = useState('');
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const editor = useRef<RichMarkdownHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uploads = useAttachmentUploads(workspaceId, issueId);
  const commentDraft = useCommentDraft(
    workspaceId,
    issueId,
    parentCommentId,
    editor
  );
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

  const syncTargets = parentCommentId === undefined ? threadTargets : [];
  const chosen =
    syncTargets.find((target) => targetKey(target) === chosenKey) ?? null;

  const syncPosted = (
    commentId: string,
    target: GithubThreadTargetRead
  ): void => {
    void syncThread(workspaceId, issueId, commentId, {
      repository_id: target.repository_id,
      number: target.number,
    })
      .then(() => {
        invalidateQueries(commentsKey(issueId));
      })
      .catch((failure: unknown) => {
        showErrorToast(
          errorMessage(
            failure,
            'The comment posted, but could not be synced to GitHub.'
          )
        );
      });
  };

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
      .then((created) => {
        if (chosen !== null) syncPosted(created.comment_id, chosen);
        setChosenKey(null);
        invalidateQueries(attachmentsKey(issueId));
        uploads.settle(linked);
        commentDraft.clear();
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
          ref={commentDraft.ref}
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
            commentDraft.save(markdown);
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
        {syncTargets.length > 0 ? (
          <ThreadSyncToggle
            targets={syncTargets}
            chosen={chosen}
            onChoose={(target) => {
              setChosenKey(target === null ? null : targetKey(target));
            }}
          />
        ) : (
          <span className="hidden text-xs text-text-faint sm:inline">
            Paste or drop images and videos
          </span>
        )}
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
      {chosen !== null && !chosen.private && (
        <p role="status" className="px-3 pb-2 text-xs text-warning">
          {PUBLIC_THREAD_WARNING}
        </p>
      )}
    </div>
  );
};

export default CommentComposer;
