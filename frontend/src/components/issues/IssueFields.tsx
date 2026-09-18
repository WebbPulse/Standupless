/**
 * The editable fields of one issue. Each control saves on change rather than
 * behind a form, because the contract makes every field its own activity row
 * and a person changing a status does not expect to then press save.
 */

import React, { useState } from 'react';
import { updateIssue } from '../../api/issues';
import { errorMessage } from '../../lib/errors';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import type { Assignable } from '../../lib/issuePeople';
import { estimateChoices, validateDateRange } from '../../lib/validation';
import type {
  EstimateScale,
  IssuePriority,
  IssueRead,
  IssueUpdate,
  LabelRead,
  StatusRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { SelectField } from '../ui/select';
import Field from '../ui/field';

/** Props for IssueFields: the issue, the lists it picks from, and the save. */
export interface IssueFieldsProps {
  issue: IssueRead;
  estimateScale: EstimateScale;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Candidate parents, already narrowed to the same project. */
  parents: IssueRead[];
  canEdit: boolean;
  workspaceId: string;
  onSaved: (issue: IssueRead) => void;
}

/** The status, priority, assignee, labels, estimate, dates and parent. */
export const IssueFields: React.FC<IssueFieldsProps> = ({
  issue,
  estimateScale,
  statuses,
  labels,
  people,
  parents,
  canEdit,
  workspaceId,
  onSaved,
}) => {
  const [error, setError] = useState<unknown>(null);
  const [startDate, setStartDate] = useState(issue.start_date ?? '');
  const [dueDate, setDueDate] = useState(issue.due_date ?? '');

  const choices = estimateChoices(estimateScale);
  const dateError = validateDateRange(startDate, dueDate);

  const save = (patch: IssueUpdate): void => {
    setError(null);
    updateIssue(workspaceId, issue.id, patch)
      .then(onSaved)
      .catch((failure: unknown) => {
        setError(failure);
      });
  };

  const toggleLabel = (labelId: string): void => {
    const next = issue.label_ids.includes(labelId)
      ? issue.label_ids.filter((id) => id !== labelId)
      : [...issue.label_ids, labelId];
    save({ label_ids: next });
  };

  const saveDate = (
    field: 'start_date' | 'due_date',
    value: string,
    other: string
  ): void => {
    const range =
      field === 'start_date'
        ? validateDateRange(value, other)
        : validateDateRange(other, value);
    if (range !== null) return;
    save({ [field]: value === '' ? null : value });
  };

  return (
    <section className="space-y-4">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that change.')}
        />
      )}

      <div className="flex flex-wrap gap-3">
        <SelectField
          id="issue-status"
          label="Status"
          className="w-40"
          disabled={!canEdit}
          value={issue.status_id}
          onChange={(event) => {
            save({ status_id: event.target.value });
          }}
        >
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="issue-priority"
          label="Priority"
          className="w-40"
          disabled={!canEdit}
          value={issue.priority}
          onChange={(event) => {
            save({ priority: event.target.value as IssuePriority });
          }}
        >
          {PRIORITIES.map((value) => (
            <option key={value} value={value}>
              {PRIORITY_LABELS[value]}
            </option>
          ))}
        </SelectField>

        <SelectField
          id="issue-assignee"
          label="Assignee"
          className="w-48"
          disabled={!canEdit}
          value={issue.assignee_id ?? ''}
          onChange={(event) => {
            save({
              assignee_id:
                event.target.value === '' ? null : event.target.value,
            });
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
            id="issue-estimate"
            label="Estimate"
            className="w-32"
            disabled={!canEdit}
            value={issue.estimate ?? ''}
            onChange={(event) => {
              save({
                estimate: event.target.value === '' ? null : event.target.value,
              });
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
          id="issue-start"
          label="Start date"
          type="date"
          className="w-40"
          disabled={!canEdit}
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
            saveDate('start_date', event.target.value, dueDate);
          }}
        />

        <Field
          id="issue-due"
          label="Due date"
          type="date"
          className="w-40"
          disabled={!canEdit}
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value);
            saveDate('due_date', event.target.value, startDate);
          }}
        />

        <SelectField
          id="issue-parent"
          label="Parent"
          className="w-56"
          disabled={!canEdit}
          value={issue.parent_id ?? ''}
          onChange={(event) => {
            save({
              parent_id: event.target.value === '' ? null : event.target.value,
            });
          }}
        >
          <option value="">No parent</option>
          {parents.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.key} {candidate.title}
            </option>
          ))}
        </SelectField>
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
                  disabled={!canEdit}
                  checked={issue.label_ids.includes(label.id)}
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
    </section>
  );
};

export default IssueFields;
