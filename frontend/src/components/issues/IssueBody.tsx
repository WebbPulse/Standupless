/**
 * The title and description of one issue, edited in place and shown as
 * Markdown. Clicking the description swaps it for a box that grows with the
 * text in the same place and type, so editing barely moves the page; Ctrl or
 * Cmd Enter saves and Escape cancels. When the surface can attach files,
 * dropping or pasting a file on the description attaches it to the issue
 * rather than inserting it.
 */

import React, { useLayoutEffect, useRef, useState } from 'react';
import { LuPencil } from 'react-icons/lu';
import { updateIssue } from '../../api/issues';
import { useAutoGrow } from '../../hooks/useAutoGrow';
import { dragHasFiles, filesFrom } from '../../lib/attachments';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { submitKeysLabel } from '../../lib/platform';
import { validateBody, validateTitle } from '../../lib/validation';
import type { IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import Input from '../ui/input';
import Label from '../ui/label';
import Markdown from '../ui/markdown';

/** Props for IssueBody: the issue, whether it may be edited, and the save. */
export interface IssueBodyProps {
  workspaceId: string;
  issue: IssueRead;
  canEdit: boolean;
  onSaved: (issue: IssueRead) => void;
  /** Attaches dropped or pasted files to the issue. Unset turns dropping off. */
  onDropFiles?: (files: File[]) => void;
}

/** The body text as prose. */
const BODY_CLASS = 'text-sm leading-6 text-text';

/** The heading and description, each editable on its own. */
export const IssueBody: React.FC<IssueBodyProps> = ({
  workspaceId,
  issue,
  canEdit,
  onSaved,
  onDropFiles,
}) => {
  const [dragging, setDragging] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState(issue.body ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const editor = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(editor);

  useLayoutEffect(() => {
    const element = editor.current;
    if (!editingBody || element === null) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editingBody]);

  const titleError = validateTitle(title);
  const bodyError = validateBody(body);

  const save = (patch: { title?: string; body?: string | null }): void => {
    setIsSaving(true);
    setError(null);
    updateIssue(workspaceId, issue.id, patch)
      .then((saved) => {
        onSaved(saved);
        setEditingTitle(false);
        setEditingBody(false);
      })
      .catch((failure: unknown) => {
        setError(failure);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const startBody = (): void => {
    setBody(issue.body ?? '');
    setEditingBody(true);
  };

  const cancelBody = (): void => {
    setBody(issue.body ?? '');
    setEditingBody(false);
  };

  const saveBody = (): void => {
    if (isSaving || bodyError !== null) return;
    if (body === (issue.body ?? '')) {
      setEditingBody(false);
      return;
    }
    save({ body: body === '' ? null : body });
  };

  const dropping = canEdit && onDropFiles !== undefined;
  const dropProps = dropping
    ? {
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
          onDropFiles(files);
        },
      }
    : {};
  const dropClass = cn(
    'rounded-md transition-colors duration-100',
    dragging &&
      'bg-accent/5 outline-1 outline-offset-4 outline-accent outline-dashed'
  );

  return (
    <section className="space-y-6">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that edit.')}
        />
      )}

      {editingTitle ? (
        <div className="space-y-2">
          <Label htmlFor="issue-title" hidden>
            Title
          </Label>
          <Input
            id="issue-title"
            value={title}
            autoComplete="off"
            autoFocus
            className="h-10 border-transparent bg-transparent px-1 text-xl font-semibold hover:border-line"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <ErrorAlert message={titleError} />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={isSaving || titleError !== null || title.trim() === ''}
              onClick={() => {
                save({ title: title.trim() });
              }}
            >
              {isSaving ? 'Saving' : 'Save title'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setTitle(issue.title);
                setEditingTitle(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-xl leading-7 font-semibold text-text">
            {issue.title}
          </h2>
          {canEdit && (
            <IconButton
              label="Edit title"
              size="sm"
              className="shrink-0"
              onClick={() => {
                setTitle(issue.title);
                setEditingTitle(true);
              }}
            >
              <LuPencil className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      )}

      <div className={cn('space-y-2', dropClass)} {...dropProps}>
        <div className="flex min-h-7 items-center justify-between gap-2">
          <h3 className="text-base font-semibold">
            {editingBody ? (
              <label htmlFor="issue-body">Description</label>
            ) : (
              'Description'
            )}
          </h3>
          {editingBody ? (
            <div className="flex items-center gap-1.5">
              <span className="hidden text-2xs text-text-faint sm:inline">
                {submitKeysLabel()} to save, Esc to cancel
              </span>
              <Button variant="ghost" size="sm" onClick={cancelBody}>
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={isSaving || bodyError !== null}
                onClick={saveBody}
              >
                {isSaving ? 'Saving' : 'Save description'}
              </Button>
            </div>
          ) : (
            canEdit && (
              <IconButton
                label="Edit description"
                size="sm"
                className="shrink-0"
                onClick={startBody}
              >
                <LuPencil className="h-3.5 w-3.5" />
              </IconButton>
            )
          )}
        </div>
        {editingBody ? (
          <>
            <textarea
              ref={editor}
              id="issue-body"
              rows={1}
              value={body}
              placeholder="Add a description..."
              className={cn(
                BODY_CLASS,
                'block w-full resize-none rounded-xs bg-transparent p-0 font-sans outline-1 outline-offset-4 outline-line placeholder:text-text-faint focus:outline-line-strong'
              )}
              onChange={(event) => {
                setBody(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  saveBody();
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelBody();
                }
              }}
              {...(dropping
                ? {
                    onPaste: (event: React.ClipboardEvent) => {
                      const files = filesFrom(event.clipboardData);
                      if (files.length === 0) return;
                      event.preventDefault();
                      onDropFiles(files);
                    },
                  }
                : {})}
            />
            <ErrorAlert message={bodyError} />
          </>
        ) : (
          <div
            className={cn(canEdit && 'cursor-text')}
            onClick={
              canEdit
                ? (event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest('a, button, input') !== null) return;
                    if ((window.getSelection()?.toString() ?? '') !== '') {
                      return;
                    }
                    startBody();
                  }
                : undefined
            }
          >
            {issue.body === null ||
            issue.body === undefined ||
            issue.body === '' ? (
              <p className={`${BODY_CLASS} text-text-muted`}>
                {canEdit ? 'Add a description...' : 'No description yet.'}
              </p>
            ) : (
              <Markdown source={issue.body} className={BODY_CLASS} />
            )}
          </div>
        )}
        {dragging && (
          <p className="text-xs text-accent">Drop to attach to this issue</p>
        )}
      </div>
    </section>
  );
};

export default IssueBody;
