/**
 * The new issue form, opened from a project's issue list. Only the title is
 * required: the server allocates the key and defaults the status to the lowest
 * position backlog one, so a person can file something without first deciding
 * where it belongs.
 */

import React, { useState } from 'react';
import { createIssue } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import type { Assignable } from '../../lib/issuePeople';
import {
  estimateChoices,
  validateDateRange,
  validateTitle,
} from '../../lib/validation';
import type {
  EstimateScale,
  IssueCreate,
  IssuePriority,
  IssueRead,
  LabelRead,
  StatusRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Field from '../ui/field';
import { SelectField } from '../ui/select';

/** Props for CreateIssueDialog: where the issue lands and what it may carry. */
export interface CreateIssueDialogProps {
  workspaceId: string;
  projectId: string;
  estimateScale: EstimateScale;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Called with the created issue, so the list can re-read from the top. */
  onCreated: (issue: IssueRead) => void;
  onClose: () => void;
}

/** A form for one new issue. */
export const CreateIssueDialog: React.FC<CreateIssueDialogProps> = ({
  workspaceId,
  projectId,
  estimateScale,
  statuses,
  labels,
  people,
  onCreated,
  onClose,
}) => {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [statusId, setStatusId] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('none');
  const [assigneeId, setAssigneeId] = useState('');
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [estimate, setEstimate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const titleError = validateTitle(title);
  const dateError = validateDateRange(startDate, dueDate);
  const choices = estimateChoices(estimateScale);
  const canSubmit =
    title.trim() !== '' &&
    titleError === null &&
    dateError === null &&
    !isSaving;

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const payload: IssueCreate = {
      project_id: projectId,
      title: title.trim(),
      ...(body === '' ? {} : { body }),
      ...(statusId === '' ? {} : { status_id: statusId }),
      ...(priority === 'none' ? {} : { priority }),
      ...(assigneeId === '' ? {} : { assignee_id: assigneeId }),
      ...(labelIds.length === 0 ? {} : { label_ids: labelIds }),
      ...(estimate === '' ? {} : { estimate }),
      ...(startDate === '' ? {} : { start_date: startDate }),
      ...(dueDate === '' ? {} : { due_date: dueDate }),
    };
    setIsSaving(true);
    createIssue(workspaceId, payload)
      .then((issue) => {
        onCreated(issue);
      })
      .catch((failure: unknown) => {
        setError(failure);
      })
      .finally(() => {
        setIsSaving(false);
      });
  };

  const toggleLabel = (labelId: string): void => {
    setLabelIds((held) =>
      held.includes(labelId)
        ? held.filter((id) => id !== labelId)
        : [...held, labelId]
    );
  };

  return (
    <form
      aria-label="New issue"
      className="space-y-4 rounded-md border border-slate-700 p-4"
      onSubmit={onSubmit}
    >
      <h3 className="text-base font-medium text-white">New issue</h3>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not create that issue.')}
        />
      )}

      <Field
        id="new-issue-title"
        label="Title"
        value={title}
        autoComplete="off"
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <ErrorAlert message={titleError} />

      <div className="space-y-1">
        <label
          htmlFor="new-issue-body"
          className="block text-sm font-medium text-slate-200"
        >
          Description
        </label>
        <textarea
          id="new-issue-body"
          rows={5}
          className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <p className="text-xs text-slate-500">Markdown is kept as written.</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <SelectField
          id="new-issue-status"
          label="Status"
          className="w-40"
          value={statusId}
          onChange={(event) => {
            setStatusId(event.target.value);
          }}
        >
          <option value="">Default</option>
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="new-issue-priority"
          label="Priority"
          className="w-40"
          value={priority}
          onChange={(event) => {
            setPriority(event.target.value as IssuePriority);
          }}
        >
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {PRIORITY_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="new-issue-assignee"
          label="Assignee"
          className="w-48"
          value={assigneeId}
          onChange={(event) => {
            setAssigneeId(event.target.value);
          }}
        >
          <option value="">Unassigned</option>
          {people.map((person) => (
            <option key={person.user_id} value={person.user_id}>
              {person.display_name ?? person.email}
            </option>
          ))}
        </SelectField>

        {choices.length > 0 && (
          <SelectField
            id="new-issue-estimate"
            label="Estimate"
            className="w-32"
            value={estimate}
            onChange={(event) => {
              setEstimate(event.target.value);
            }}
          >
            <option value="">None</option>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </SelectField>
        )}

        <Field
          id="new-issue-start"
          label="Start date"
          type="date"
          className="w-40"
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
          }}
        />
        <Field
          id="new-issue-due"
          label="Due date"
          type="date"
          className="w-40"
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value);
          }}
        />
      </div>
      <ErrorAlert message={dateError} />

      {labels.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-200">Labels</legend>
          <div className="flex flex-wrap gap-3">
            {labels.map((label) => (
              <label
                key={label.id}
                className="flex items-center gap-2 text-sm text-slate-300"
              >
                <input
                  type="checkbox"
                  checked={labelIds.includes(label.id)}
                  onChange={() => {
                    toggleLabel(label.id);
                  }}
                />
                {label.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={!canSubmit}>
          {isSaving ? 'Creating' : 'Create issue'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
};

export default CreateIssueDialog;
