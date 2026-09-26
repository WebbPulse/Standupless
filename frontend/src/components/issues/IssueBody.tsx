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
 * paint of the page does not wait on it. When the surface can attach files,
 * dropping or pasting a file on the description attaches it to the issue.
 */

import React, { Suspense, lazy, useState } from 'react';
import { updateIssue } from '../../api/issues';
import { dragHasFiles, filesFrom } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { submitKeysLabel } from '../../lib/platform';
import { validateBody } from '../../lib/validation';
import type { IssueRead } from '../../types/Api';
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
  /** Attaches dropped or pasted files to the issue. Unset turns dropping off. */
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

  const attach =
    canEdit && onDropFiles !== undefined
      ? (files: File[]) => {
          setDragging(false);
          onDropFiles(files);
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
        <div className="flex min-h-7 items-center justify-between gap-2">
          <h3 className="text-base font-semibold">Description</h3>
          {canEdit && (bodyFocused || isSaving) && (
            <span className="text-2xs text-text-faint">
              {isSaving
                ? 'Saving'
                : `${submitKeysLabel()} to save, Esc to cancel`}
            </span>
          )}
        </div>
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
              value={body}
              editable={canEdit}
              ariaLabel="Description"
              autoFocus={focusOnLoad}
              className={BODY_CLASS}
              onCommit={saveBody}
              onFocusChange={setBodyFocused}
              {...(canEdit ? { placeholder: PLACEHOLDER } : {})}
              {...(attach === undefined ? {} : { onFiles: attach })}
            />
          </Suspense>
        ) : (
          <p className={cn(BODY_CLASS, 'text-text-muted')}>
            No description yet.
          </p>
        )}
        <ErrorAlert message={bodyError} />
        {dragging && (
          <p className="text-xs text-accent">Drop to attach to this issue</p>
        )}
      </div>
    </section>
  );
};

export default IssueBody;
