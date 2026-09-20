/**
 * The title and description of one issue, edited in place. The preview is
 * preformatted rather than rendered markdown: no renderer is a dependency of
 * this frontend, and adding one for a preview is not worth the bundle.
 */

import React, { useState } from 'react';
import { LuPencil } from 'react-icons/lu';
import { updateIssue } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { validateBody, validateTitle } from '../../lib/validation';
import type { IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import Input, { Textarea } from '../ui/input';
import Label from '../ui/label';

/** Props for IssueBody: the issue, whether it may be edited, and the save. */
export interface IssueBodyProps {
  workspaceId: string;
  issue: IssueRead;
  canEdit: boolean;
  onSaved: (issue: IssueRead) => void;
}

/** The body text, wrapped like prose rather than code. */
const BODY_CLASS = 'whitespace-pre-wrap font-sans text-sm leading-6 text-text';

/** The heading and description, each editable on its own. */
export const IssueBody: React.FC<IssueBodyProps> = ({
  workspaceId,
  issue,
  canEdit,
  onSaved,
}) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(issue.title);
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState(issue.body ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

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

      {editingBody ? (
        <div className="space-y-3">
          <Label htmlFor="issue-body">Description</Label>
          <Textarea
            id="issue-body"
            rows={10}
            autoFocus
            className="font-mono"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <ErrorAlert message={bodyError} />
          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-text-muted">Preview</h3>
            <pre
              className={`${BODY_CLASS} rounded-md border border-line bg-surface px-3 py-2`}
            >
              {body === '' ? 'Nothing written yet.' : body}
            </pre>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={isSaving || bodyError !== null}
              onClick={() => {
                save({ body: body === '' ? null : body });
              }}
            >
              {isSaving ? 'Saving' : 'Save description'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBody(issue.body ?? '');
                setEditingBody(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Description</h3>
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBody(issue.body ?? '');
                  setEditingBody(true);
                }}
              >
                <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                Edit description
              </Button>
            )}
          </div>
          <pre
            className={
              issue.body === null || issue.body === undefined
                ? `${BODY_CLASS} text-text-muted`
                : BODY_CLASS
            }
          >
            {issue.body ?? 'No description yet.'}
          </pre>
        </div>
      )}
    </section>
  );
};

export default IssueBody;
