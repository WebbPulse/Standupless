/**
 * The new issue form, opened as a dialog from a team's issue list. Only the
 * title is required: the server allocates the key and defaults the status to
 * the lowest position backlog one, so a person can file something without
 * first deciding where it belongs.
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
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { Textarea } from '../ui/input';
import Label from '../ui/label';
import { SelectField } from '../ui/select';

/** Props for CreateIssueDialog: where the issue lands and what it may carry. */
export interface CreateIssueDialogProps {
  workspaceId: string;
  teamId: string;
  estimateScale: EstimateScale;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Called with the created issue, so the list can re-read from the top. */
  onCreated: (issue: IssueRead) => void;
  onClose: () => void;
}

/** A dialog holding the form for one new issue. */
export const CreateIssueDialog: React.FC<CreateIssueDialogProps> = ({
  workspaceId,
  teamId,
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
      team_id: teamId,
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
    <Dialog open onClose={onClose} title="New issue" size="lg">
      <form aria-label="New issue" className="space-y-4" onSubmit={onSubmit}>
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
          <Label htmlFor="new-issue-body">Description</Label>
          <Textarea
            id="new-issue-body"
            rows={5}
            aria-describedby="new-issue-body-hint"
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <p id="new-issue-body-hint" className="text-xs text-text-faint">
            Markdown is kept as written.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            id="new-issue-status"
            label="Status"
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
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
          <Field
            id="new-issue-due"
            label="Due date"
            type="date"
            value={dueDate}
            onChange={(event) => {
              setDueDate(event.target.value);
            }}
          />
        </div>
        <ErrorAlert message={dateError} />

        {labels.length > 0 && (
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-text-muted">
              Labels
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {labels.map((label) => (
                <Checkbox
                  key={label.id}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: label.color }}
                      />
                      {label.name}
                    </span>
                  }
                  checked={labelIds.includes(label.id)}
                  onChange={() => {
                    toggleLabel(label.id);
                  }}
                />
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {isSaving ? 'Creating' : 'Create issue'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default CreateIssueDialog;
