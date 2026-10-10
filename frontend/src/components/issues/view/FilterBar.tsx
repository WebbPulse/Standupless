/**
 * The filters over a list or board. The Filter button walks from a property
 * to its values, and each active filter is a chip reading "Status is any of
 * Todo, In Progress" whose verb flips between keeping and excluding and whose
 * values reopen the same list. Chips are ANDed together. Values are offered
 * by name, so a status or label shared by name across teams is one choice
 * that matches in every team. A date field takes one day instead, picked
 * from a few relative presets or a calendar, and its verb flips between
 * "before" and "after".
 */

import React, { useState } from 'react';
import {
  LuBan,
  LuBox,
  LuCalendar,
  LuCalendarClock,
  LuCalendarPlus,
  LuCircleDashed,
  LuClock,
  LuIterationCw,
  LuLink,
  LuOctagonAlert,
  LuPenLine,
  LuUsers,
  LuListFilter,
  LuMilestone,
  LuSignal,
  LuTag,
  LuTriangle,
  LuUserRound,
  LuX,
} from 'react-icons/lu';
import { NONE } from '../../../api/issues';
import { PRIORITIES, PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personAvatar, personLabel } from '../../../lib/issuePeople';
import {
  FILTER_FIELDS,
  FILTER_LABELS,
  KEEP_ONLY_FIELDS,
  RELATIVE_CYCLES,
  fieldsFor,
  isDateField,
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
import { pickableLabels } from '../../../lib/labelGroups';
import { SLA_STATUSES, SLA_STATUS_LABELS } from '../../../lib/sla';
import { cn } from '../../../lib/cn';
import type { LinkType } from '../../../types/Api';
import { estimateChoices } from '../../../lib/validation';
import Avatar from '../../ui/avatar';
import Button from '../../ui/button';
import { Combobox, type ComboboxOption } from '../../ui/combobox';
import { Input } from '../../ui/input';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import { Popover } from '../../ui/popover';
import { useShortcut } from '../../../hooks/useShortcuts';

const FIELD_ICONS: Record<FilterField, React.ReactNode> = {
  status: <LuCircleDashed className="h-3.5 w-3.5" />,
  assignee: <LuUserRound className="h-3.5 w-3.5" />,
  creator: <LuPenLine className="h-3.5 w-3.5" />,
  priority: <LuSignal className="h-3.5 w-3.5" />,
  label: <LuTag className="h-3.5 w-3.5" />,
  estimate: <LuTriangle className="h-3.5 w-3.5" />,
  team: <LuUsers className="h-3.5 w-3.5" />,
  project: <LuBox className="h-3.5 w-3.5" />,
  milestone: <LuMilestone className="h-3.5 w-3.5" />,
  cycle: <LuIterationCw className="h-3.5 w-3.5" />,
  created: <LuCalendarPlus className="h-3.5 w-3.5" />,
  updated: <LuCalendarClock className="h-3.5 w-3.5" />,
  due: <LuCalendar className="h-3.5 w-3.5" />,
  sla: <LuClock className="h-3.5 w-3.5" />,
  blocked: <LuOctagonAlert className="h-3.5 w-3.5" />,
  blocking: <LuBan className="h-3.5 w-3.5" />,
  relation: <LuLink className="h-3.5 w-3.5" />,
};

/** How each relative cycle reads in the cycle filter. */
const RELATIVE_CYCLE_LABELS: Record<(typeof RELATIVE_CYCLES)[number], string> =
  {
    current: 'Current cycle',
    next: 'Next cycle',
    previous: 'Previous cycle',
  };

/** The link types a relation filter offers, as the issue page names them. */
const RELATION_CHOICES: { value: LinkType; label: string }[] = [
  { value: 'blocks', label: 'Blocking' },
  { value: 'blocked_by', label: 'Blocked by' },
  { value: 'relates_to', label: 'Related to' },
  { value: 'duplicate_of', label: 'Duplicate of' },
];

/** A day as `YYYY-MM-DD` in local time, the way a date input reads it. */
const isoDay = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
};

/** The day `days` from today, negative for the past. */
const dayFromToday = (days: number, today: Date = new Date()): string => {
  const date = new Date(today);
  date.setDate(date.getDate() + days);
  return isoDay(date);
};

/** The relative days a date filter offers, past ones for most fields, both ways for due. */
const datePresets = (field: FilterField): { label: string; days: number }[] => {
  const past = [
    { label: '1 day ago', days: -1 },
    { label: '1 week ago', days: -7 },
    { label: '2 weeks ago', days: -14 },
    { label: '1 month ago', days: -30 },
    { label: '3 months ago', days: -90 },
    { label: '6 months ago', days: -180 },
  ];
  if (field !== 'due') return past;
  return [
    { label: 'Today', days: 0 },
    { label: 'Tomorrow', days: 1 },
    { label: 'In 1 week', days: 7 },
    { label: 'In 2 weeks', days: 14 },
    { label: 'In 1 month', days: 30 },
    ...past.slice(0, 3),
  ];
};

/** How a stored day reads on a chip. */
const dayLabel = (day: string): string => {
  const [year, month, date] = day.split('-').map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    return day;
  }
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

/** Sets a date field's one bound, replacing any bound it held with the same verb. */
const setDateBound = (
  filters: FilterClause[],
  field: FilterField,
  op: 'before' | 'after',
  day: string
): FilterClause[] => {
  const index = filters.findIndex(
    (clause) => clause.field === field && clause.op === op
  );
  if (index < 0) return [...filters, { field, op, values: [day] }];
  return filters.map((clause, at) =>
    at === index ? { ...clause, values: [day] } : clause
  );
};

/**
 * Every estimate any team's scale can hold: the T-shirt sizes, then every
 * point value in numeric order, each offered once however many scales share it.
 */
const ESTIMATE_FILTER_GROUPS: { group: string; values: string[] }[] = [
  {
    group: 'T-shirt',
    values: estimateChoices('tshirt', { extended: true }),
  },
  {
    group: 'Points',
    values: [
      ...new Set(
        (['exponential', 'fibonacci', 'linear'] as const).flatMap((scale) =>
          estimateChoices(scale, { extended: true, allowZero: true })
        )
      ),
    ].sort((left, right) => Number(left) - Number(right)),
  },
];

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

/** The two answers a yes or no filter takes. */
const yesNo = (icon: React.ReactNode): FilterChoice[] => [
  { option: { value: 'true', label: 'Yes', icon }, ids: ['true'] },
  { option: { value: 'false', label: 'No', icon: hollow }, ids: ['false'] },
];

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
          icon: <StatusIcon status={status} statuses={context.statuses} />,
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
    case 'assignee':
    case 'creator': {
      const me = context.people.find(
        (person) => person.user_id === context.currentUserId
      );
      return [
        ...(field === 'assignee'
          ? [
              {
                option: { value: NONE, label: 'No assignee', icon: hollow },
                ids: [NONE],
              },
            ]
          : []),
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
            icon: (
              <Avatar
                name={personLabel(person)}
                src={personAvatar(person)}
                size="xs"
              />
            ),
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
          pickableLabels(context.labels).sort(
            (left, right) =>
              (left.group_name === undefined ? 0 : 1) -
                (right.group_name === undefined ? 0 : 1) ||
              (left.group_name ?? '').localeCompare(right.group_name ?? '') ||
              left.name.localeCompare(right.name)
          ),
          labelGroupKey,
          (label, value) => ({
            value,
            label: label.name,
            ...(label.group_name === undefined
              ? {}
              : { group: label.group_name }),
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
    case 'estimate':
      return [
        {
          option: { value: NONE, label: 'No estimate', icon: hollow },
          ids: [NONE],
        },
        ...ESTIMATE_FILTER_GROUPS.flatMap(({ group, values }) =>
          values.map((value) => ({
            option: {
              value,
              label: value,
              group,
              icon: <LuTriangle className="h-3.5 w-3.5 text-text-muted" />,
            },
            ids: [value],
          }))
        ),
      ];
    case 'team':
      return (context.teams ?? []).map((team) => ({
        option: {
          value: team.id,
          label: team.name,
          icon: <LuUsers className="h-3.5 w-3.5 text-text-muted" />,
          ...(team.key === undefined ? {} : { detail: team.key }),
        },
        ids: [team.id],
      }));
    case 'created':
    case 'updated':
    case 'due':
      return [];
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
        ...RELATIVE_CYCLES.map((value) => ({
          option: {
            value,
            label: RELATIVE_CYCLE_LABELS[value],
            icon: <LuIterationCw className="h-3.5 w-3.5 text-accent" />,
          },
          ids: [value],
        })),
        ...context.cycles.map((cycle) => ({
          option: {
            value: cycle.cycle_id,
            label: cycle.name,
            icon: <LuIterationCw className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [cycle.cycle_id],
        })),
      ];
    case 'sla':
      return SLA_STATUSES.map((status) => ({
        option: {
          value: status,
          label: SLA_STATUS_LABELS[status],
          icon:
            status === 'none' ? (
              hollow
            ) : (
              <LuClock
                className={cn(
                  'h-3.5 w-3.5',
                  status === 'on_track' && 'text-text-muted',
                  status === 'at_risk' && 'text-warning',
                  status === 'breached' && 'text-danger'
                )}
              />
            ),
        },
        ids: [status],
      }));
    case 'blocked':
      return yesNo(<LuOctagonAlert className="h-3.5 w-3.5 text-danger" />);
    case 'blocking':
      return yesNo(<LuBan className="h-3.5 w-3.5 text-warning" />);
    case 'relation':
      return RELATION_CHOICES.map((choice) => ({
        option: {
          value: choice.value,
          label: choice.label,
          icon: <LuLink className="h-3.5 w-3.5 text-text-muted" />,
        },
        ids: [choice.value],
      }));
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

/**
 * A date field's day picker: relative presets resolved to a fixed day when
 * picked, so a saved view keeps the day it was saved with, and a calendar
 * input for any other day.
 */
const DateList: React.FC<{
  field: FilterField;
  op: 'before' | 'after';
  filters: FilterClause[];
  onChange: (filters: FilterClause[]) => void;
}> = ({ field, op, filters, onChange }) => {
  const held = filters.find(
    (clause) => clause.field === field && clause.op === op
  )?.values[0];
  const presets = datePresets(field);
  return (
    <Combobox
      label={`${FILTER_LABELS[field]} ${op}`}
      placeholder={`${FILTER_LABELS[field]} ${op}...`}
      options={presets.map((preset) => ({
        value: String(preset.days),
        label: preset.label,
        icon: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
        detail: dayLabel(dayFromToday(preset.days)),
      }))}
      selected={presets
        .filter((preset) => dayFromToday(preset.days) === held)
        .map((preset) => String(preset.days))}
      onSelect={(value) => {
        onChange(setDateBound(filters, field, op, dayFromToday(Number(value))));
      }}
      footer={
        <label className="flex items-center gap-2 border-t border-line px-2 py-2 text-xs text-text-muted">
          Custom date
          <Input
            type="date"
            aria-label={`${FILTER_LABELS[field]} ${op} date`}
            className="flex-1"
            value={held ?? ''}
            onChange={(event) => {
              const day = event.target.value;
              if (day !== '') onChange(setDateBound(filters, field, op, day));
            }}
          />
        </label>
      }
    />
  );
};

/** The list of one field's values, toggling each on the filters. */
const ValueList: React.FC<{
  field: FilterField;
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
}> = ({ field, filters, context, onChange }) => {
  if (isDateField(field)) {
    return (
      <DateList
        field={field}
        op={field === 'due' ? 'before' : 'after'}
        filters={filters}
        onChange={onChange}
      />
    );
  }
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
  const dated = clause.op === 'before' || clause.op === 'after';
  const choices = dated ? [] : filterChoices(clause.field, context);
  const names = chosen(clause, choices).map((choice) => choice.option.label);
  const summary = dated
    ? dayLabel(clause.values[0] ?? '')
    : names.length === 0
      ? `${String(clause.values.length)} values`
      : names.length <= 2
        ? names.join(', ')
        : `${String(names.length)} ${FILTER_LABELS[clause.field].toLowerCase()}`;
  const many = clause.values.length > 1;
  const verb =
    clause.op === 'before' || clause.op === 'after'
      ? clause.op
      : clause.op === 'is'
        ? many
          ? 'is any of'
          : 'is'
        : many
          ? 'is none of'
          : 'is not';
  const flipped: FilterClause['op'] =
    clause.op === 'is'
      ? 'is_not'
      : clause.op === 'is_not'
        ? 'is'
        : clause.op === 'before'
          ? 'after'
          : 'before';
  const flipTaken = filters.some(
    (item) =>
      item !== clause && item.field === clause.field && item.op === flipped
  );
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
      {KEEP_ONLY_FIELDS.has(clause.field) ? (
        <span className="flex h-full items-center border-r border-line px-2 text-text-muted">
          {clause.values.length > 1 ? 'is any of' : 'is'}
        </span>
      ) : (
        <button
          type="button"
          aria-label={`${FILTER_LABELS[clause.field]} ${dated ? clause.op : clause.op === 'is' ? 'is' : 'is not'}, switch`}
          disabled={flipTaken}
          onClick={() => {
            replace({ ...clause, op: flipped });
          }}
          className={cn(segment, 'border-r border-line text-text-muted')}
        >
          {verb}
        </button>
      )}
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
        {clause.op === 'before' || clause.op === 'after' ? (
          <DateList
            field={clause.field}
            op={clause.op}
            filters={filters}
            onChange={onChange}
          />
        ) : (
          <ValueList
            field={clause.field}
            filters={filters}
            context={context}
            onChange={onChange}
          />
        )}
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

/** The Filter button that adds a filter, walking from a field to its values; F opens it. */
export const FilterButton: React.FC<FilterBarProps> = ({
  filters,
  context,
  onChange,
  fields,
}) => {
  const offered = fields ?? fieldsFor(FILTER_FIELDS, context);
  const [field, setField] = useState<FilterField | null>(null);
  const [open, setOpen] = useState(false);
  useShortcut({
    keys: 'f',
    label: 'Add filter',
    group: 'List',
    enabled: !open,
    handler: () => {
      setField(null);
      setOpen(true);
    },
  });
  return (
    <Popover
      label="Add filter"
      contentClassName="w-72 p-0"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setField(null);
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
