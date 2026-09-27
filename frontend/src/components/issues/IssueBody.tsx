/**
 * The title and description of one issue, edited as the text they render as.
 * There is no edit mode and no pencil: the title is a borderless field in the
 * heading's type, and the description is a rich Markdown surface that looks
 * the same whether or not a caret is in it. Both save when focus leaves them,
 * the description also on Ctrl or Cmd Enter, and Escape puts back what was
 * saved.
 *
 * The editor is its own lazily loaded chunk. Until it arrives the description
 * renders through the static Markdown renderer in the same type, so the first
 * paint of the page does not wait on it. When the description may be edited,
 * pasting, dropping or picking an image or video puts it in the text behind a
 * progress bar, and any other file becomes a link to it. Each file is an
 * attachment of the issue, embedded by its stable content path.
 */

import React, { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { uploadAttachment } from '../../api/discussion';
import { updateIssue } from '../../api/issues';
import { dragHasFiles, filesFrom } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { contentPath, mediaKindOf } from '../../lib/media';
import { rememberPreview, useMedia } from '../../lib/mediaContext';
import { submitKeysLabel } from '../../lib/platform';
import { attachmentsKey } from '../../lib/queryKeys';
import { validateBody } from '../../lib/validation';
import type { IssueRead } from '../../types/Api';
import type { RichMarkdownHandle } from '../editor/RichMarkdownEditor';
import type { UploadFile } from '../editor/mediaNodes';
import { ErrorAlert } from '../ui/alert';
import Markdown from '../ui/markdown';
import IssueTitle from './IssueTitle';

const RichMarkdownEditor = lazy(() => import('../editor/RichMarkdownEditor'));

/** Props for IssueBody: the issue, whether it may be edited, and the save. */
export interface IssueBodyProps {
  workspaceId: string;
  issue: IssueRead;
  canEdit: boolean;
  onSaved: (issue: IssueRead) => void;
  /**
   * Attaches files dropped before the editor has loaded to the issue. Once it
   * has, files go into the text instead.
   */
  onDropFiles?: (files: File[]) => void;
}

/** The body text as prose, shared by the editor and its stand in. */
const BODY_CLASS = 'text-sm leading-6 text-text';

/** The words an empty description shows to someone who may write one. */
const PLACEHOLDER = 'Add a description...';

/** The description as static Markdown, shown while the editor loads. */
const StaticBody: React.FC<{
  body: string;
  canEdit: boolean;
  onActivate: () => void;
}> = ({ body, canEdit, onActivate }) =>
  body === '' ? (
    <p
      className={cn(BODY_CLASS, 'text-text-muted', canEdit && 'cursor-text')}
      onClick={canEdit ? onActivate : undefined}
    >
      {PLACEHOLDER}
    </p>
  ) : (
    <div
      className={cn(canEdit && 'cursor-text')}
      onClick={
        canEdit
          ? (event) => {
              const target = event.target as HTMLElement;
              if (target.closest('a, button, input') !== null) return;
              onActivate();
            }
          : undefined
      }
    >
      <Markdown source={body} className={BODY_CLASS} />
    </div>
  );

/** The heading and description, each editable in place. */
export const IssueBody: React.FC<IssueBodyProps> = ({
  workspaceId,
  issue,
  canEdit,
  onSaved,
  onDropFiles,
}) => {
  const [dragging, setDragging] = useState(false);
  const [bodyFocused, setBodyFocused] = useState(false);
  const [focusOnLoad, setFocusOnLoad] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const editor = useRef<RichMarkdownHandle>(null);
  const { refresh } = useMedia();
  const issueId = issue.id;

  const uploadFile = useCallback<UploadFile>(
    async (file, onProgress) => {
      const attachment = await uploadAttachment(
        workspaceId,
        issueId,
        file,
        undefined,
        (sent) => {
          onProgress(sent.total === 0 ? 1 : sent.loaded / sent.total);
        }
      );
      rememberPreview(attachment.attachment_id, file);
      refresh();
      invalidateQueries(attachmentsKey(issueId));
      const kind = mediaKindOf(file.type);
      return {
        src: contentPath(workspaceId, attachment.attachment_id, issueId, kind),
        kind,
      };
    },
    [workspaceId, issueId, refresh]
  );

  const body = issue.body ?? '';

  const save = (patch: {
    title?: string;
    body?: string | null;
  }): Promise<boolean> => {
    setIsSaving(true);
    setError(null);
    return updateIssue(workspaceId, issue.id, patch)
      .then((saved) => {
        onSaved(saved);
        return true;
      })
      .catch((failure: unknown) => {
        setError(failure);
        return false;
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const saveBody = (markdown: string): Promise<boolean> | boolean => {
    const invalid = validateBody(markdown);
    setBodyError(invalid);
    if (invalid !== null) return false;
    return save({ body: markdown === '' ? null : markdown });
  };

  const attach = canEdit
    ? (files: File[]) => {
        setDragging(false);
        const surface = editor.current;
        if (surface !== null) surface.insertFiles(files);
        else onDropFiles?.(files);
      }
    : undefined;

  const dropProps =
    attach === undefined
      ? {}
      : {
          onDragOver: (event: React.DragEvent) => {
            if (!dragHasFiles(event.dataTransfer)) return;
            event.preventDefault();
            setDragging(true);
          },
          onDragLeave: (event: React.DragEvent) => {
            if (
              event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              return;
            }
            setDragging(false);
          },
          onDrop: (event: React.DragEvent) => {
            const files = filesFrom(event.dataTransfer);
            setDragging(false);
            if (files.length === 0) return;
            event.preventDefault();
            attach(files);
          },
        };
  const dropClass = cn(
    'rounded-md transition-colors duration-100',
    dragging &&
      'bg-accent/5 outline-1 outline-offset-4 outline-accent outline-dashed'
  );

  const showBody = canEdit || body !== '';

  return (
    <section className="space-y-6">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that edit.')}
        />
      )}

      <IssueTitle
        title={issue.title}
        canEdit={canEdit}
        onSave={(title) => save({ title })}
      />

      <div className={cn('space-y-2', dropClass)} {...dropProps}>
        {showBody ? (
          <Suspense
            fallback={
              <StaticBody
                body={body}
                canEdit={canEdit}
                onActivate={() => {
                  setFocusOnLoad(true);
                }}
              />
            }
          >
            <RichMarkdownEditor
              ref={editor}
              value={body}
              editable={canEdit}
              ariaLabel="Description"
              autoFocus={focusOnLoad}
              className={BODY_CLASS}
              onCommit={saveBody}
              onFocusChange={setBodyFocused}
              {...(canEdit ? { placeholder: PLACEHOLDER } : {})}
              {...(canEdit ? { uploadFile } : {})}
            />
          </Suspense>
        ) : (
          <p className={cn(BODY_CLASS, 'text-text-muted')}>
            No description yet.
          </p>
        )}
        {canEdit && (bodyFocused || isSaving) && (
          <p className="text-right text-2xs text-text-faint">
            {isSaving
              ? 'Saving'
              : `${submitKeysLabel()} to save, Esc to cancel`}
          </p>
        )}
        <ErrorAlert message={bodyError} />
        {dragging && (
          <p className="text-xs text-accent">Drop to add to the description</p>
        )}
      </div>
    </section>
  );
};

export default IssueBody;
