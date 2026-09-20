/**
 * The editable fields of one issue, laid out as the property rows of the
 * detail rail. Each control saves on change rather than behind a form, because
 * the contract makes every field its own activity row and a person changing a
 * status does not expect to then press save.
 */

import React, { useState } from 'react';
import { updateIssue } from '../../api/issues';
import { cn } from '../../lib/cn';
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
import Checkbox from '../ui/checkbox';
import Input from '../ui/input';
import Label from '../ui/label';
import Select from '../ui/select';

/**
 * Turns the select or input inside a property row into a chip: no border
 * until hovered, sitting flat on the rail, one row high.
 */
const CHIP_CONTROL_CLASS =
  '[&_select]:h-7 [&_select]:border-transparent [&_select]:bg-transparent [&_select:hover]:bg-raised [&_input]:h-7 [&_input]:border-transparent [&_input]:bg-transparent [&_input:hover]:bg-raised';

/** Props for PropertyRow: the control's id, its name and the control. */
export interface PropertyRowProps {
  id: string;
  label: string;
  children: React.ReactNode;
  className?: string;
}

/** One property in the rail: a fixed width name beside a chip-like control. */
export const PropertyRow: React.FC<PropertyRowProps> = ({
  id,
  label,
  children,
  className = '',
}) => (
  <div className={cn('flex min-h-7 items-center gap-2', className)}>
    <Label htmlFor={id} className="w-24 shrink-0">
      {label}
    </Label>
    <div className={cn('min-w-0 flex-1', CHIP_CONTROL_CLASS)}>{children}</div>
  </div>
);

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
    <section className="space-y-2">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not save that change.')}
        />
      )}

      <PropertyRow id="issue-status" label="Status">
        <Select
          id="issue-status"
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
        </Select>
      </PropertyRow>

      <PropertyRow id="issue-priority" label="Priority">
        <Select
          id="issue-priority"
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
        </Select>
      </PropertyRow>

      <PropertyRow id="issue-assignee" label="Assignee">
        <Select
          id="issue-assignee"
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
        </Select>
      </PropertyRow>

      {choices.length > 0 && (
        <PropertyRow id="issue-estimate" label="Estimate">
          <Select
            id="issue-estimate"
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
          </Select>
        </PropertyRow>
      )}

      <PropertyRow id="issue-start" label="Start date">
        <Input
          id="issue-start"
          type="date"
          disabled={!canEdit}
          value={startDate}
          onChange={(event) => {
            setStartDate(event.target.value);
            saveDate('start_date', event.target.value, dueDate);
          }}
        />
      </PropertyRow>

      <PropertyRow id="issue-due" label="Due date">
        <Input
          id="issue-due"
          type="date"
          disabled={!canEdit}
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value);
            saveDate('due_date', event.target.value, startDate);
          }}
        />
      </PropertyRow>

      <ErrorAlert message={dateError} />

      <PropertyRow id="issue-parent" label="Parent">
        <Select
          id="issue-parent"
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
        </Select>
      </PropertyRow>

      {labels.length > 0 && (
        <fieldset className="flex gap-2 pt-1">
          <legend className="sr-only">Labels</legend>
          <span
            aria-hidden="true"
            className="w-24 shrink-0 pt-0.5 text-xs font-medium text-text-muted"
          >
            Labels
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1.5 px-2.5">
            {labels.map((label) => (
              <Checkbox
                key={label.id}
                disabled={!canEdit}
                checked={issue.label_ids.includes(label.id)}
                onChange={() => {
                  toggleLabel(label.id);
                }}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    {label.name}
                  </span>
                }
              />
            ))}
          </div>
        </fieldset>
      )}
    </section>
  );
};

export default IssueFields;
