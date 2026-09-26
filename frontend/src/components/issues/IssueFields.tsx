/**
 * The editable fields of one issue, laid out as the property rows of the
 * detail rail and the peek pane. Each row is an inline picker that reports a
 * patch the moment a value is chosen, because every field is its own activity
 * row and a person changing a status does not expect to then press save. The
 * surface owns the write, which is what lets it apply the change optimistically.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { Assignable } from '../../lib/issuePeople';
import type {
  EstimateScale,
  IssueRead,
  IssueUpdate,
  LabelRead,
  StatusRead,
} from '../../types/Api';
import {
  AssigneePicker,
  DatePicker,
  EstimatePicker,
  LabelsPicker,
  ParentPicker,
  PriorityPicker,
  StatusPicker,
} from './PropertyPickers';

/** Props for PropertyRow: the property's name and its picker. */
export interface PropertyRowProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * One property in the rail: a fixed width name beside its picker. The name is
 * hidden from assistive technology because the picker already announces it.
 */
export const PropertyRow: React.FC<PropertyRowProps> = ({
  label,
  children,
  className = '',
}) => (
  <div className={cn('flex min-h-7 items-start gap-2', className)}>
    <span
      aria-hidden="true"
      className="w-24 shrink-0 truncate pt-1.5 text-xs text-text-muted"
    >
      {label}
    </span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

/** Props for PropertySection: a heading over a group of rows. */
export interface PropertySectionProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

/** A titled group of rail rows, divided from the next by a rule. */
export const PropertySection: React.FC<PropertySectionProps> = ({
  title,
  children,
  className = '',
}) => (
  <section
    aria-label={title}
    className={cn('space-y-0.5 border-b border-line pb-3', className)}
  >
    <h3 className="px-0 pb-1.5 text-xs font-medium text-text-faint">{title}</h3>
    {children}
  </section>
);

/** Props for IssueFields: the issue, the lists it picks from, and the patch. */
export interface IssueFieldsProps {
  issue: IssueRead;
  estimateScale: EstimateScale;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Candidate parents, already narrowed to the same team. */
  parents: IssueRead[];
  canEdit: boolean;
  /** Called with each change as a one field patch. */
  onUpdate: (patch: IssueUpdate) => void;
  /** Lists the signed in person first in the assignee picker. */
  currentUserId?: string;
  /** Creates a label from typed text. Unset hides the create row. */
  onCreateLabel?: (name: string) => Promise<LabelRead | null>;
}

/** The status, priority, assignee, estimate, dates, parent and labels. */
export const IssueFields: React.FC<IssueFieldsProps> = ({
  issue,
  estimateScale,
  statuses,
  labels,
  people,
  parents,
  canEdit,
  onUpdate,
  currentUserId,
  onCreateLabel,
}) => {
  const disabled = !canEdit;
  return (
    <>
      <PropertySection title="Properties">
        <PropertyRow label="Status">
          <StatusPicker
            disabled={disabled}
            statuses={statuses}
            value={issue.status_id}
            onChange={(statusId) => {
              onUpdate({ status_id: statusId });
            }}
          />
        </PropertyRow>

        <PropertyRow label="Priority">
          <PriorityPicker
            disabled={disabled}
            value={issue.priority}
            onChange={(priority) => {
              onUpdate({ priority });
            }}
          />
        </PropertyRow>

        <PropertyRow label="Assignee">
          <AssigneePicker
            disabled={disabled}
            people={people}
            value={issue.assignee_id}
            {...(currentUserId === undefined ? {} : { currentUserId })}
            onChange={(assigneeId) => {
              onUpdate({ assignee_id: assigneeId });
            }}
          />
        </PropertyRow>

        {estimateScale !== 'off' && (
          <PropertyRow label="Estimate">
            <EstimatePicker
              disabled={disabled}
              scale={estimateScale}
              value={issue.estimate}
              onChange={(estimate) => {
                onUpdate({ estimate });
              }}
            />
          </PropertyRow>
        )}

        <PropertyRow label="Start date">
          <DatePicker
            disabled={disabled}
            field="Start date"
            value={issue.start_date}
            {...(issue.due_date === null ? {} : { max: issue.due_date })}
            onChange={(startDate) => {
              onUpdate({ start_date: startDate });
            }}
          />
        </PropertyRow>

        <PropertyRow label="Due date">
          <DatePicker
            disabled={disabled}
            field="Due date"
            value={issue.due_date}
            {...(issue.start_date === null ? {} : { min: issue.start_date })}
            onChange={(dueDate) => {
              onUpdate({ due_date: dueDate });
            }}
          />
        </PropertyRow>

        <PropertyRow label="Parent">
          <ParentPicker
            disabled={disabled}
            candidates={parents}
            value={issue.parent_id}
            onChange={(parentId) => {
              onUpdate({ parent_id: parentId });
            }}
          />
        </PropertyRow>
      </PropertySection>

      <PropertySection title="Labels">
        <LabelsPicker
          disabled={disabled}
          labels={labels}
          value={issue.label_ids}
          {...(onCreateLabel === undefined ? {} : { onCreate: onCreateLabel })}
          onChange={(labelIds) => {
            onUpdate({ label_ids: labelIds });
          }}
        />
      </PropertySection>
    </>
  );
};

export default IssueFields;
