/**
 * The filters over a list or board. The Filter button walks from a property
 * to its values, and each active filter is a chip reading "Status is Todo,
 * In Progress" whose verb flips between "is" and "is not" and whose values
 * reopen the same list. Values are offered by name, so a status or label
 * shared by name across teams is one choice that matches in every team.
 */

import React, { useState } from 'react';
import {
  LuBox,
  LuCircleDashed,
  LuIterationCw,
  LuListFilter,
  LuMilestone,
  LuSignal,
  LuTag,
  LuUserRound,
  LuX,
} from 'react-icons/lu';
import { NONE } from '../../../api/issues';
import { PRIORITIES, PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personLabel } from '../../../lib/issuePeople';
import {
  FILTER_FIELDS,
  FILTER_LABELS,
  fieldsFor,
  labelGroupKey,
  statusGroupKey,
  type FilterClause,
  type FilterField,
  type IssueContext,
} from '../../../lib/issueView';
import {
  STATUS_CATEGORY_LABELS,
  sortStatuses,
} from '../../../lib/propertyOptions';
import { cn } from '../../../lib/cn';
import Avatar from '../../ui/avatar';
import Button from '../../ui/button';
import { Combobox, type ComboboxOption } from '../../ui/combobox';
import { PriorityGlyph, StatusGlyph } from '../../ui/glyphs';
import { Popover } from '../../ui/popover';

const FIELD_ICONS: Record<FilterField, React.ReactNode> = {
  status: <LuCircleDashed className="h-3.5 w-3.5" />,
  assignee: <LuUserRound className="h-3.5 w-3.5" />,
  priority: <LuSignal className="h-3.5 w-3.5" />,
  label: <LuTag className="h-3.5 w-3.5" />,
  project: <LuBox className="h-3.5 w-3.5" />,
  milestone: <LuMilestone className="h-3.5 w-3.5" />,
  cycle: <LuIterationCw className="h-3.5 w-3.5" />,
};

/** One choice of a field: what it shows and the ids it stands for. */
interface FilterChoice {
  option: ComboboxOption;
  ids: string[];
}

const hollow = (
  <span
    aria-hidden="true"
    className="h-3.5 w-3.5 rounded-full border border-dashed border-text-faint"
  />
);

/** Every choice a field offers, grouping like named statuses and labels. */
const filterChoices = (
  field: FilterField,
  context: IssueContext
): FilterChoice[] => {
  const byKey = <T,>(
    items: T[],
    key: (item: T) => string,
    option: (item: T, key: string) => ComboboxOption,
    id: (item: T) => string
  ): FilterChoice[] => {
    const choices = new Map<string, FilterChoice>();
    for (const item of items) {
      const value = key(item);
      const held = choices.get(value);
      if (held === undefined) {
        choices.set(value, { option: option(item, value), ids: [id(item)] });
      } else {
        held.ids.push(id(item));
      }
    }
    return [...choices.values()];
  };
  switch (field) {
    case 'status':
      return byKey(
        sortStatuses(context.statuses),
        statusGroupKey,
        (status, value) => ({
          value,
          label: status.name,
          icon: <StatusGlyph category={status.category} />,
          group: STATUS_CATEGORY_LABELS[status.category],
        }),
        (status) => status.id
      );
    case 'priority':
      return PRIORITIES.map((priority) => ({
        option: {
          value: priority,
          label: PRIORITY_LABELS[priority],
          icon: <PriorityGlyph priority={priority} />,
        },
        ids: [priority],
      }));
    case 'assignee': {
      const me = context.people.find(
        (person) => person.user_id === context.currentUserId
      );
      return [
        {
          option: { value: NONE, label: 'No assignee', icon: hollow },
          ids: [NONE],
        },
        ...[
          ...(me === undefined ? [] : [me]),
          ...context.people
            .filter((person) => person !== me)
            .sort((left, right) =>
              personLabel(left).localeCompare(personLabel(right))
            ),
        ].map((person) => ({
          option: {
            value: person.user_id,
            label:
              person === me
                ? `${personLabel(person)} (you)`
                : personLabel(person),
            icon: <Avatar name={personLabel(person)} size="xs" />,
            keywords: [person.email],
          },
          ids: [person.user_id],
        })),
      ];
    }
    case 'label':
      return [
        {
          option: { value: NONE, label: 'No label', icon: hollow },
          ids: [NONE],
        },
        ...byKey(
          [...context.labels].sort((left, right) =>
            left.name.localeCompare(right.name)
          ),
          labelGroupKey,
          (label, value) => ({
            value,
            label: label.name,
            icon: (
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: label.color }}
              />
            ),
          }),
          (label) => label.id
        ),
      ];
    case 'project':
      return [
        {
          option: { value: NONE, label: 'No project', icon: hollow },
          ids: [NONE],
        },
        ...context.projects.map((project) => ({
          option: {
            value: project.project_id,
            label: project.name,
            icon: <LuBox className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [project.project_id],
        })),
      ];
    case 'milestone':
      return [
        {
          option: { value: NONE, label: 'No milestone', icon: hollow },
          ids: [NONE],
        },
        ...(context.milestones ?? []).map((milestone) => ({
          option: {
            value: milestone.milestone_id,
            label: milestone.name,
            icon: <LuMilestone className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [milestone.milestone_id],
        })),
      ];
    case 'cycle':
      return [
        {
          option: { value: NONE, label: 'No cycle', icon: hollow },
          ids: [NONE],
        },
        ...context.cycles.map((cycle) => ({
          option: {
            value: cycle.cycle_id,
            label: cycle.name,
            icon: <LuIterationCw className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [cycle.cycle_id],
        })),
      ];
  }
};

/** Adds or removes a choice's ids on a field's clause. */
const toggleChoice = (
  filters: FilterClause[],
  field: FilterField,
  choice: FilterChoice,
  op: FilterClause['op'] = 'is'
): FilterClause[] => {
  const index = filters.findIndex((clause) => clause.field === field);
  const held = filters[index];
  if (held === undefined) {
    return [...filters, { field, op, values: [...choice.ids] }];
  }
  const on = choice.ids.every((id) => held.values.includes(id));
  const values = on
    ? held.values.filter((id) => !choice.ids.includes(id))
    : [...held.values, ...choice.ids.filter((id) => !held.values.includes(id))];
  if (values.length === 0) return filters.filter((_, at) => at !== index);
  return filters.map((clause, at) =>
    at === index ? { ...clause, values } : clause
  );
};

/** The choices a clause has on. */
const chosen = (
  clause: FilterClause | undefined,
  choices: FilterChoice[]
): FilterChoice[] =>
  clause === undefined
    ? []
    : choices.filter((choice) =>
        choice.ids.every((id) => clause.values.includes(id))
      );

/** The list of one field's values, toggling each on the filters. */
const ValueList: React.FC<{
  field: FilterField;
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
}> = ({ field, filters, context, onChange }) => {
  const choices = filterChoices(field, context);
  const clause = filters.find((item) => item.field === field);
  return (
    <Combobox
      label={FILTER_LABELS[field]}
      placeholder={`Filter by ${FILTER_LABELS[field].toLowerCase()}...`}
      options={choices.map((choice) => choice.option)}
      selected={chosen(clause, choices).map((choice) => choice.option.value)}
      multiple
      emptyMessage="Nothing to filter on yet."
      onSelect={(value) => {
        const choice = choices.find((item) => item.option.value === value);
        if (choice !== undefined)
          onChange(toggleChoice(filters, field, choice));
      }}
    />
  );
};

/** One active filter as a chip. */
const FilterChip: React.FC<{
  clause: FilterClause;
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
}> = ({ clause, filters, context, onChange }) => {
  const choices = filterChoices(clause.field, context);
  const names = chosen(clause, choices).map((choice) => choice.option.label);
  const summary =
    names.length === 0
      ? `${String(clause.values.length)} values`
      : names.length <= 2
        ? names.join(', ')
        : `${String(names.length)} ${FILTER_LABELS[clause.field].toLowerCase()}`;
  const replace = (next: FilterClause | null): void => {
    onChange(
      filters.flatMap((item) =>
        item === clause ? (next === null ? [] : [next]) : [item]
      )
    );
  };
  const segment =
    'flex h-full items-center px-2 hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';
  return (
    <span className="flex h-7 items-center overflow-hidden rounded-md border border-line text-xs">
      <span className="flex h-full items-center gap-1.5 border-r border-line px-2 text-text-muted">
        {FIELD_ICONS[clause.field]}
        {FILTER_LABELS[clause.field]}
      </span>
      <button
        type="button"
        aria-label={`${FILTER_LABELS[clause.field]} ${clause.op === 'is' ? 'is' : 'is not'}, switch`}
        onClick={() => {
          replace({ ...clause, op: clause.op === 'is' ? 'is_not' : 'is' });
        }}
        className={cn(segment, 'border-r border-line text-text-muted')}
      >
        {clause.op === 'is'
          ? clause.values.length > 1
            ? 'is any of'
            : 'is'
          : 'is not'}
      </button>
      <Popover
        label={`${FILTER_LABELS[clause.field]} values`}
        contentClassName="w-72 p-0"
        className="h-full"
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className={cn(segment, 'max-w-56 border-r border-line text-text')}
          >
            <span className="truncate">{summary}</span>
          </button>
        )}
      >
        <ValueList
          field={clause.field}
          filters={filters}
          context={context}
          onChange={onChange}
        />
      </Popover>
      <button
        type="button"
        aria-label={`Remove ${FILTER_LABELS[clause.field]} filter`}
        onClick={() => {
          replace(null);
        }}
        className={cn(segment, 'px-1.5 text-text-faint hover:text-text')}
      >
        <LuX className="h-3 w-3" />
      </button>
    </span>
  );
};

/** Props for FilterBar. */
export interface FilterBarProps {
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
  /** The fields this surface filters on, every field when unset. */
  fields?: FilterField[];
}

/** The Filter button that adds a filter, walking from a field to its values. */
export const FilterButton: React.FC<FilterBarProps> = ({
  filters,
  context,
  onChange,
  fields,
}) => {
  const offered = fields ?? fieldsFor(FILTER_FIELDS, context);
  const [field, setField] = useState<FilterField | null>(null);
  return (
    <Popover
      label="Add filter"
      contentClassName="w-72 p-0"
      onOpenChange={(open) => {
        if (!open) setField(null);
      }}
      trigger={(props) => (
        <Button {...props} size="sm" variant="ghost" className="gap-1.5">
          <LuListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          Filter
        </Button>
      )}
    >
      {field === null ? (
        <Combobox
          label="Filter by"
          placeholder="Filter by..."
          options={offered.map((item) => ({
            value: item,
            label: FILTER_LABELS[item],
            icon: FIELD_ICONS[item],
          }))}
          selected={[]}
          onSelect={(value) => {
            setField(value as FilterField);
          }}
        />
      ) : (
        <ValueList
          field={field}
          filters={filters}
          context={context}
          onChange={onChange}
        />
      )}
    </Popover>
  );
};

/** The active filters as chips, with a way to clear them all. */
export const FilterChips: React.FC<FilterBarProps> = ({
  filters,
  context,
  onChange,
}) => {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((clause) => (
        <FilterChip
          key={`${clause.field}.${clause.op}`}
          clause={clause}
          filters={filters}
          context={context}
          onChange={onChange}
        />
      ))}
      <button
        type="button"
        onClick={() => {
          onChange([]);
        }}
        className="h-7 rounded-md px-2 text-xs text-text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        Clear
      </button>
    </div>
  );
};
