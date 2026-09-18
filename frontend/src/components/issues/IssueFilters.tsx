/**
 * The filter and sort controls above an issue list. The values are held by the
 * page rather than here, so the same bar can drive a project list and the
 * cross-workspace one, and so a filter change is one state update the list
 * re-reads from.
 */

import React from 'react';
import { ME } from '../../api/issues';
import {
  PRIORITIES,
  PRIORITY_LABELS,
  SORTS,
  SORT_LABELS,
} from '../../lib/issueDisplay';
import type { FilterState } from '../../lib/issueFilters';
import type { Assignable } from '../../lib/issuePeople';
import type { IssueSort, LabelRead, StatusRead } from '../../types/Api';
import Field from '../ui/field';
import { SelectField } from '../ui/select';

/** Props for IssueFilters: the held values, and how to change one. */
export interface IssueFiltersProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** Hides the status and label filters, which only a single project can offer. */
  scoped?: boolean;
  /** Hides the assignee filter, for a list already fixed to one person. */
  hideAssignee?: boolean;
}

/** The filter, search and sort row above an issue list. */
export const IssueFilters: React.FC<IssueFiltersProps> = ({
  filters,
  onChange,
  statuses,
  labels,
  people,
  scoped = true,
  hideAssignee = false,
}) => {
  const set = <K extends keyof FilterState>(
    key: K,
    value: FilterState[K]
  ): void => {
    onChange({ ...filters, [key]: value });
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field
        id="issue-search"
        label="Search"
        type="search"
        className="w-52"
        placeholder="Key or title"
        autoComplete="off"
        value={filters.q}
        onChange={(event) => {
          set('q', event.target.value);
        }}
      />

      {scoped && (
        <SelectField
          id="issue-status-filter"
          label="Status"
          className="w-40"
          value={filters.statusId}
          onChange={(event) => {
            set('statusId', event.target.value);
          }}
        >
          <option value="">Any status</option>
          {statuses.map((status) => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </SelectField>
      )}

      {!hideAssignee && (
        <SelectField
          id="issue-assignee-filter"
          label="Assignee"
          className="w-48"
          value={filters.assigneeId}
          onChange={(event) => {
            set('assigneeId', event.target.value);
          }}
        >
          <option value="">Anyone</option>
          <option value={ME}>Me</option>
          {people.map((person) => (
            <option key={person.user_id} value={person.user_id}>
              {person.display_name ?? person.email}
            </option>
          ))}
        </SelectField>
      )}

      {scoped && (
        <SelectField
          id="issue-label-filter"
          label="Label"
          className="w-40"
          value={filters.labelId}
          onChange={(event) => {
            set('labelId', event.target.value);
          }}
        >
          <option value="">Any label</option>
          {labels.map((label) => (
            <option key={label.id} value={label.id}>
              {label.name}
            </option>
          ))}
        </SelectField>
      )}

      <SelectField
        id="issue-priority-filter"
        label="Priority"
        className="w-40"
        value={filters.priority}
        onChange={(event) => {
          set('priority', event.target.value);
        }}
      >
        <option value="">Any priority</option>
        {PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {PRIORITY_LABELS[priority]}
          </option>
        ))}
      </SelectField>

      <SelectField
        id="issue-sort"
        label="Sort"
        className="w-44"
        value={filters.sort}
        onChange={(event) => {
          set('sort', event.target.value as IssueSort);
        }}
      >
        {SORTS.map((sort) => (
          <option key={sort} value={sort}>
            {SORT_LABELS[sort]}
          </option>
        ))}
      </SelectField>
    </div>
  );
};

export default IssueFilters;
