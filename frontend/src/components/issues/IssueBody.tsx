/**
 * The title and description of one issue, edited in place. The preview is
 * preformatted rather than rendered markdown: no renderer is a dependency of
 * this frontend, and adding one for a preview is not worth the bundle.
 */

import React, { useState } from 'react';
import { updateIssue } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { validateBody, validateTitle } from '../../lib/validation';
import type { IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';

/** Props for IssueBody: the issue, whether it may be edited, and the save. */
export interface IssueBodyProps {
  workspaceId: string;
  issue: IssueRead;
  canEdit: boolean;
  onSaved: (issue: IssueRead) => void;
}

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
    <section className="space-y-4">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that edit.')}
        />
      )}

      {editingTitle ? (
        <div className="space-y-2">
          <Field
            id="issue-title"
            label="Title"
            value={title}
            autoComplete="off"
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <ErrorAlert message={titleError} />
          <div className="flex gap-2">
            <Button
              disabled={isSaving || titleError !== null || title.trim() === ''}
              onClick={() => {
                save({ title: title.trim() });
              }}
            >
              {isSaving ? 'Saving' : 'Save title'}
            </Button>
            <Button
              variant="secondary"
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
        <div className="flex flex-wrap items-baseline gap-3">
          <span className="font-mono text-sm text-slate-400">{issue.key}</span>
          <h2 className="text-lg font-medium text-white">{issue.title}</h2>
          {canEdit && (
            <Button
              variant="secondary"
              onClick={() => {
                setTitle(issue.title);
                setEditingTitle(true);
              }}
            >
              Edit title
            </Button>
          )}
        </div>
      )}

      {editingBody ? (
        <div className="space-y-2">
          <label
            htmlFor="issue-body"
            className="block text-sm font-medium text-slate-200"
          >
            Description
          </label>
          <textarea
            id="issue-body"
            rows={10}
            className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <ErrorAlert message={bodyError} />
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-slate-200">Preview</h3>
            <pre className="whitespace-pre-wrap rounded-md border border-slate-700 px-3 py-2 font-mono text-sm text-slate-300">
              {body === '' ? 'Nothing written yet.' : body}
            </pre>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={isSaving || bodyError !== null}
              onClick={() => {
                save({ body: body === '' ? null : body });
              }}
            >
              {isSaving ? 'Saving' : 'Save description'}
            </Button>
            <Button
              variant="secondary"
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
          <h3 className="text-sm font-medium text-slate-200">Description</h3>
          <pre className="whitespace-pre-wrap rounded-md border border-slate-700 px-3 py-2 font-mono text-sm text-slate-300">
            {issue.body ?? 'No description yet.'}
          </pre>
          {canEdit && (
            <Button
              variant="secondary"
              onClick={() => {
                setBody(issue.body ?? '');
                setEditingBody(true);
              }}
            >
              Edit description
            </Button>
          )}
        </div>
      )}
    </section>
  );
};

export default IssueBody;
