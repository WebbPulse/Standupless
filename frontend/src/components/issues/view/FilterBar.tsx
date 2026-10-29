/**
 * The filters over a list or board. The Filter button walks from a property
 * to its values, and each active filter is a chip reading "Status is any of
 * Todo, In Progress" whose verb flips between keeping and excluding and whose
 * values reopen the same list. Chips combine under the bar's match, every
 * filter by default or any one of them, and a filter group boxes a few chips
 * that combine under a match of their own and stand as one filter. Values
 * are offered by name, so a status or label shared by name across teams is
 * one choice that matches in every team. A date field takes one day instead,
 * picked from a few relative presets or a calendar, and its verb flips
 * between "before" and "after". Content takes free text matched against the
 * title and description. A customer's revenue or size, or how many customer
 * requests an issue carries, takes one whole number whose verb flips between
 * "at least" and "at most", and revenue reads as a compact amount. As in Linear, Shift F drops the filter added last and
 * Alt Shift F clears every filter, the same as the chips' Clear button, and
 * Alt click or Alt Enter on a value makes it the only one chosen. The team
 * filter leads with My teams, which follows whoever views the list.
 */

import React, { useState } from 'react';
import {
  LuBell,
  LuBox,
  LuBuilding2,
  LuCalendar,
  LuCalendarRange,
  LuCalendarCheck,
  LuCalendarClock,
  LuCalendarPlus,
  LuCircleAlert,
  LuCircleDashed,
  LuCircleDot,
  LuCrown,
  LuDollarSign,
  LuMessageSquare,
  LuClock,
  LuCornerLeftUp,
  LuFileText,
  LuIterationCw,
  LuLayers,
  LuLink,
  LuListTree,
  LuPenLine,
  LuPlus,
  LuRocket,
  LuUsers,
  LuListFilter,
  LuMilestone,
  LuSignal,
  LuTag,
  LuTriangle,
  LuUserRound,
  LuUsersRound,
  LuX,
} from 'react-icons/lu';
import { IMPORTANT_CUSTOMER, NONE } from '../../../api/issues';
import { useMilestoneContext } from '../../../hooks/useMilestoneContext';
import { useTriageTeamIds } from '../../../hooks/useTriageTeams';
import { PRIORITIES, PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personAvatar, personLabel } from '../../../lib/issuePeople';
import {
  ALL_OF_FIELDS,
  CYCLE_ADDED_LABELS,
  CYCLE_ADDED_PHASES,
  FILTER_LABELS,
  KEEP_ONLY_FIELDS,
  MAX_FILTER_GROUPS,
  MY_TEAMS,
  RELATIVE_CYCLES,
  filterFieldsFor,
  isDateField,
  isFilterNumber,
  isNumberField,
  releasesInOrder,
  isTextField,
  labelGroupKey,
  statusGroupKey,
  type FilterClause,
  type FilterField,
  type FilterGroup,
  type FilterMatch,
  type IssueContext,
  type IssueCustomerField,
} from '../../../lib/issueView';
import { revenueLabel, sizeLabel } from '../../../lib/customerDisplay';
import {
  STATUS_CATEGORY_LABELS,
  sortStatuses,
} from '../../../lib/propertyOptions';
import { pickableLabels } from '../../../lib/labelGroups';
import { SLA_STATUSES, SLA_STATUS_LABELS } from '../../../lib/sla';
import {
  TRIAGE_GROUP_KEY,
  TRIAGE_STATUS,
  TRIAGE_STATUS_ID,
  TRIAGE_STATUS_NAME,
} from '../../../lib/triageStatus';
import { cn } from '../../../lib/cn';
import { isApplePlatform } from '../../../lib/platform';
import type { LinkType } from '../../../types/Api';
import { estimateChoices } from '../../../lib/validation';
import Avatar from '../../ui/avatar';
import Button from '../../ui/button';
import { Combobox, type ComboboxOption } from '../../ui/combobox';
import { Input } from '../../ui/input';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import { Popover } from '../../ui/popover';
import {
  BlockedGlyph,
  BlockedIcon,
  BlockingGlyph,
  BlockingIcon,
} from '../RelationGlyphs';
import { useShortcut } from '../../../hooks/useShortcuts';
import {
  dayBoundChip,
  dayLabel,
  resolveDayBound,
  type DayPreset,
} from '../../../lib/filterDays';

const FIELD_ICONS: Record<FilterField, React.ReactNode> = {
  status: <LuCircleDashed className="h-3.5 w-3.5" />,
  assignee: <LuUserRound className="h-3.5 w-3.5" />,
  creator: <LuPenLine className="h-3.5 w-3.5" />,
  subscriber: <LuBell className="h-3.5 w-3.5" />,
  priority: <LuSignal className="h-3.5 w-3.5" />,
  label: <LuTag className="h-3.5 w-3.5" />,
  estimate: <LuTriangle className="h-3.5 w-3.5" />,
  team: <LuUsers className="h-3.5 w-3.5" />,
  project: <LuBox className="h-3.5 w-3.5" />,
  milestone: <LuMilestone className="h-3.5 w-3.5" />,
  cycle: <LuIterationCw className="h-3.5 w-3.5" />,
  cycle_added: <LuIterationCw className="h-3.5 w-3.5" />,
  cycle_added_at: <LuCalendarRange className="h-3.5 w-3.5" />,
  parent: <LuCornerLeftUp className="h-3.5 w-3.5" />,
  sub_issues: <LuListTree className="h-3.5 w-3.5" />,
  content: <LuFileText className="h-3.5 w-3.5" />,
  created: <LuCalendarPlus className="h-3.5 w-3.5" />,
  updated: <LuCalendarClock className="h-3.5 w-3.5" />,
  completed: <LuCalendarCheck className="h-3.5 w-3.5" />,
  due: <LuCalendar className="h-3.5 w-3.5" />,
  sla: <LuClock className="h-3.5 w-3.5" />,
  blocked: <BlockedGlyph className="h-3.5 w-3.5" />,
  blocking: <BlockingGlyph className="h-3.5 w-3.5" />,
  relation: <LuLink className="h-3.5 w-3.5" />,
  customer: <LuBuilding2 className="h-3.5 w-3.5" />,
  customer_status: <LuCircleDot className="h-3.5 w-3.5" />,
  customer_tier: <LuCrown className="h-3.5 w-3.5" />,
  customer_revenue: <LuDollarSign className="h-3.5 w-3.5" />,
  customer_size: <LuUsersRound className="h-3.5 w-3.5" />,
  customer_requests: <LuMessageSquare className="h-3.5 w-3.5" />,
  customer_important: <LuCircleAlert className="h-3.5 w-3.5" />,
  release: <LuRocket className="h-3.5 w-3.5" />,
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

/**
 * The context a field's choices are drawn from. Outside a project's own list
 * the context carries no milestones, so a milestone filter reads them from
 * each project the list knows, and the other fields use the context as it is.
 */
const useChoiceContext = (
  context: IssueContext,
  field: FilterField
): IssueContext => useMilestoneContext(context, field === 'milestone');

/**
 * The relative bounds a date filter offers, past ones for most fields, both
 * ways for due. Each stores its offset, such as `-2w`, so a saved view keeps
 * rolling with today.
 */
const datePresets = (field: FilterField): DayPreset[] => {
  const past: DayPreset[] = [
    { label: '1 day ago', value: '-1d' },
    { label: '1 week ago', value: '-1w' },
    { label: '2 weeks ago', value: '-2w' },
    { label: '1 month ago', value: '-1m' },
    { label: '3 months ago', value: '-3m' },
    { label: '6 months ago', value: '-6m' },
  ];
  if (field !== 'due') return past;
  return [
    { label: 'Today', value: 'today' },
    { label: 'Tomorrow', value: '+1d' },
    { label: 'In 1 week', value: '+1w' },
    { label: 'In 2 weeks', value: '+2w' },
    { label: 'In 1 month', value: '+1m' },
    ...past.slice(0, 3),
  ];
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

/** Sets a number field's one bound, replacing any bound it held with the same verb. */
const setNumberBound = (
  filters: FilterClause[],
  field: FilterField,
  op: 'at_least' | 'at_most',
  value: string
): FilterClause[] => {
  const index = filters.findIndex(
    (clause) => clause.field === field && clause.op === op
  );
  if (index < 0) return [...filters, { field, op, values: [value] }];
  return filters.map((clause, at) =>
    at === index ? { ...clause, values: [value] } : clause
  );
};

/** How a number filter's bound reads: revenue as a compact amount, size as a compact count. */
const numberLabel = (field: FilterField, value: string): string => {
  const amount = Number(value);
  if (field === 'customer_revenue') return revenueLabel(amount) ?? value;
  if (field === 'customer_size') return sizeLabel(amount) ?? value;
  return value;
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

/**
 * The choices of a customer status or tier filter: no customer first, then
 * each entry of the workspace's list, in its own order and colour.
 */
const customerFieldChoices = (
  fields: readonly IssueCustomerField[]
): FilterChoice[] => [
  {
    option: { value: NONE, label: 'No customer', icon: hollow },
    ids: [NONE],
  },
  ...fields.map((field) => ({
    option: {
      value: field.id,
      label: field.name,
      icon: (
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 rounded-full bg-text-faint"
          style={
            field.color === null || field.color === undefined
              ? undefined
              : { backgroundColor: field.color }
          }
        />
      ),
    },
    ids: [field.id],
  })),
];

/** The Triage choice a status filter offers when a team in the list has triage on. */
const TRIAGE_CHOICE: FilterChoice = {
  option: {
    value: TRIAGE_GROUP_KEY,
    label: TRIAGE_STATUS_NAME,
    icon: <StatusIcon status={TRIAGE_STATUS} />,
    group: TRIAGE_STATUS_NAME,
  },
  ids: [TRIAGE_STATUS_ID],
};

/** Whether any team a list spans has triage on, so its status filter offers Triage. */
const useTriageInList = (context: IssueContext): boolean => {
  const triageTeams = useTriageTeamIds();
  const teamIds = [
    ...context.statuses.map((status) => status.team_id),
    ...(context.teams ?? []).map((team) => team.id),
  ];
  return teamIds.some(
    (teamId) => teamId !== undefined && triageTeams.has(teamId)
  );
};

/**
 * Every choice a field offers, grouping like named statuses and labels.
 * Triage leads the status choices when a team in the list has it on.
 */
const filterChoices = (
  field: FilterField,
  context: IssueContext,
  triage = false
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
      return [
        ...(triage ? [TRIAGE_CHOICE] : []),
        ...byKey(
          sortStatuses(context.statuses),
          statusGroupKey,
          (status, value) => ({
            value,
            label: status.name,
            icon: <StatusIcon status={status} statuses={context.statuses} />,
            group: STATUS_CATEGORY_LABELS[status.category],
          }),
          (status) => status.id
        ),
      ];
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
    case 'creator':
    case 'subscriber': {
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
      return [
        {
          option: {
            value: MY_TEAMS,
            label: 'My teams',
            icon: <LuUsers className="h-3.5 w-3.5 text-accent" />,
          },
          ids: [MY_TEAMS],
        },
        ...(context.teams ?? []).map((team) => ({
          option: {
            value: team.id,
            label: team.name,
            icon: <LuUsers className="h-3.5 w-3.5 text-text-muted" />,
            ...(team.key === undefined ? {} : { detail: team.key }),
          },
          ids: [team.id],
        })),
      ];
    case 'created':
    case 'updated':
    case 'completed':
    case 'due':
    case 'cycle_added_at':
    case 'content':
    case 'customer_revenue':
    case 'customer_size':
    case 'customer_requests':
      return [];
    case 'customer_status':
      return customerFieldChoices(context.customerStatuses ?? []);
    case 'customer_tier':
      return customerFieldChoices(context.customerTiers ?? []);
    case 'customer_important':
      return yesNo(<LuCircleAlert className="h-3.5 w-3.5 text-warning" />);
    case 'parent':
      return [
        {
          option: {
            value: NONE,
            label: 'No parent (top level)',
            icon: hollow,
          },
          ids: [NONE],
        },
        ...[...(context.parents?.entries() ?? [])].map(([id, parent]) => ({
          option: {
            value: id,
            label: parent.title,
            detail: parent.key,
            icon: <LuCornerLeftUp className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [id],
        })),
      ];
    case 'sub_issues':
      return yesNo(<LuListTree className="h-3.5 w-3.5" />);
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
        ...(context.milestones ?? []).map((milestone) => {
          const project = context.projects.find(
            (item) => item.project_id === milestone.project_id
          );
          return {
            option: {
              value: milestone.milestone_id,
              label: milestone.name,
              ...(project === undefined ? {} : { group: project.name }),
              icon: <LuMilestone className="h-3.5 w-3.5 text-text-muted" />,
            },
            ids: [milestone.milestone_id],
          };
        }),
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
    case 'cycle_added':
      return CYCLE_ADDED_PHASES.map((phase) => ({
        option: {
          value: phase,
          label: CYCLE_ADDED_LABELS[phase],
          icon: (
            <LuIterationCw
              className={cn(
                'h-3.5 w-3.5',
                phase === 'planned' ? 'text-accent' : 'text-warning'
              )}
            />
          ),
        },
        ids: [phase],
      }));
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
      return yesNo(<BlockedIcon className="h-3.5 w-3.5" />);
    case 'blocking':
      return yesNo(<BlockingIcon className="h-3.5 w-3.5" />);
    case 'relation':
      return RELATION_CHOICES.map((choice) => ({
        option: {
          value: choice.value,
          label: choice.label,
          icon: <LuLink className="h-3.5 w-3.5 text-text-muted" />,
        },
        ids: [choice.value],
      }));
    case 'customer':
      return [
        {
          option: { value: NONE, label: 'No customer', icon: hollow },
          ids: [NONE],
        },
        {
          option: {
            value: IMPORTANT_CUSTOMER,
            label: 'Important request',
            icon: <LuCircleAlert className="h-3.5 w-3.5 text-warning" />,
          },
          ids: [IMPORTANT_CUSTOMER],
        },
        ...(context.customers ?? []).map((customer) => ({
          option: {
            value: customer.id,
            label: customer.name,
            icon: <LuBuilding2 className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [customer.id],
        })),
      ];
    case 'release':
      return [
        {
          option: { value: NONE, label: 'No release', icon: hollow },
          ids: [NONE],
        },
        ...releasesInOrder(context.releases ?? []).map((release) => ({
          option: {
            value: release.id,
            label: release.name,
            icon: <LuRocket className="h-3.5 w-3.5 text-text-muted" />,
          },
          ids: [release.id],
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

/** Sets a field's clause to exactly one choice's ids, as Alt click asks, keeping its verb. */
const onlyChoice = (
  filters: FilterClause[],
  field: FilterField,
  choice: FilterChoice
): FilterClause[] => {
  const index = filters.findIndex((clause) => clause.field === field);
  if (index === -1) {
    return [...filters, { field, op: 'is', values: [...choice.ids] }];
  }
  return filters.map((clause, at) =>
    at === index ? { ...clause, values: [...choice.ids] } : clause
  );
};

/** The footer hint naming the key that picks one value alone: Option on macOS, Alt elsewhere. */
export const selectOnlyHint = (apple: boolean = isApplePlatform()): string =>
  `${apple ? 'Option' : 'Alt'}+click to select only one`;

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
 * A date field's day picker: relative presets stored as their offset, so a
 * saved view keeps rolling with today, and a calendar input that stores the
 * absolute day it names.
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
        value: preset.value,
        label: preset.label,
        icon: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
        detail: dayLabel(resolveDayBound(preset.value)),
      }))}
      selected={presets
        .filter((preset) => preset.value === held)
        .map((preset) => preset.value)}
      onSelect={(value) => {
        onChange(setDateBound(filters, field, op, value));
      }}
      footer={
        <label className="flex items-center gap-2 border-t border-line px-2 py-2 text-xs text-text-muted">
          Custom date
          <Input
            type="date"
            aria-label={`${FILTER_LABELS[field]} ${op} date`}
            className="flex-1"
            value={held === undefined ? '' : resolveDayBound(held)}
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

/** The filters with a text field's clause set to `text`, or dropped when it is blank. */
const setTextValue = (
  filters: FilterClause[],
  field: FilterField,
  text: string
): FilterClause[] => {
  const value = text.trim();
  const index = filters.findIndex((clause) => clause.field === field);
  if (value === '') {
    return index === -1 ? filters : filters.filter((_, at) => at !== index);
  }
  if (index === -1) return [...filters, { field, op: 'is', values: [value] }];
  return filters.map((clause, at) =>
    at === index ? { ...clause, values: [value] } : clause
  );
};

/** A text field's input, applied on Enter so each keystroke does not reload the list. */
const TextValue: React.FC<{
  field: FilterField;
  filters: FilterClause[];
  onChange: (filters: FilterClause[]) => void;
}> = ({ field, filters, onChange }) => {
  const held = filters.find((clause) => clause.field === field)?.values[0];
  const [text, setText] = useState(held ?? '');
  return (
    <form
      className="flex flex-col gap-1.5 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        onChange(setTextValue(filters, field, text));
      }}
    >
      <Input
        aria-label={`${FILTER_LABELS[field]} contains`}
        placeholder="Title or description contains..."
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <span className="px-0.5 text-xs text-text-faint">
        Press Enter to apply
      </span>
    </form>
  );
};

/**
 * A number field's bound: a verb switch between at least and at most and a
 * whole number applied on Enter, so each keystroke does not reload the list.
 * The request count also offers No requests, an upper bound of 0.
 */
const NumberValue: React.FC<{
  field: FilterField;
  op: 'at_least' | 'at_most';
  filters: FilterClause[];
  onChange: (filters: FilterClause[]) => void;
}> = ({ field, op: initialOp, filters, onChange }) => {
  const [op, setOp] = useState<'at_least' | 'at_most'>(initialOp);
  const held = filters.find(
    (clause) => clause.field === field && clause.op === op
  )?.values[0];
  const [text, setText] = useState(held ?? '');
  const value = text.trim().replace(/[,_\s]/g, '');
  const valid = isFilterNumber(value);
  const label = FILTER_LABELS[field];
  return (
    <form
      className="flex flex-col gap-1.5 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) {
          onChange(setNumberBound(filters, field, op, String(Number(value))));
        }
      }}
    >
      <div
        role="radiogroup"
        aria-label={`${label} bound`}
        className="flex gap-1"
      >
        {(['at_least', 'at_most'] as const).map((verb) => (
          <button
            key={verb}
            type="button"
            role="radio"
            aria-checked={op === verb}
            onClick={() => {
              setOp(verb);
            }}
            className={cn(
              'h-6 rounded px-2 text-xs focus-visible:outline-2 focus-visible:outline-accent',
              op === verb
                ? 'bg-raised text-text'
                : 'text-text-muted hover:bg-raised hover:text-text'
            )}
          >
            {verb === 'at_least' ? 'At least' : 'At most'}
          </button>
        ))}
      </div>
      <Input
        aria-label={`${label} ${op === 'at_least' ? 'at least' : 'at most'}`}
        inputMode="numeric"
        placeholder={
          field === 'customer_revenue' ? 'Amount, such as 50000' : 'Number'
        }
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <span className="px-0.5 text-xs text-text-faint">
        {text.trim() !== '' && !valid
          ? 'Enter a whole number'
          : valid
            ? `Press Enter to apply ${numberLabel(field, String(Number(value)))}`
            : 'Press Enter to apply'}
      </span>
      {field === 'customer_requests' ? (
        <button
          type="button"
          onClick={() => {
            onChange(
              setNumberBound(
                filters.filter(
                  (clause) =>
                    !(clause.field === field && clause.op === 'at_least')
                ),
                field,
                'at_most',
                '0'
              )
            );
          }}
          className="flex h-7 items-center gap-2 rounded px-1.5 text-left text-xs text-text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          {hollow}
          No requests
        </button>
      ) : null}
    </form>
  );
};

/** The list of one field's values, toggling each on the filters. */
const ValueList: React.FC<{
  field: FilterField;
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
}> = ({ field, filters, context, onChange }) => {
  const triage = useTriageInList(context);
  const choiceContext = useChoiceContext(context, field);
  if (isTextField(field)) {
    return <TextValue field={field} filters={filters} onChange={onChange} />;
  }
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
  if (isNumberField(field)) {
    return (
      <NumberValue
        field={field}
        op="at_least"
        filters={filters}
        onChange={onChange}
      />
    );
  }
  const choices = filterChoices(field, choiceContext, triage);
  const clause = filters.find(
    (item) =>
      item.field === field && item.op !== 'before' && item.op !== 'after'
  );
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
      onSelectOnly={(value) => {
        const choice = choices.find((item) => item.option.value === value);
        if (choice !== undefined) onChange(onlyChoice(filters, field, choice));
      }}
      footer={
        choices.length > 1 ? (
          <span className="px-0.5 text-xs text-text-faint">
            {selectOnlyHint()}
          </span>
        ) : undefined
      }
    />
  );
};

/** The next verb a chip's switch moves to: is and is not, with includes all of between them for labels. */
const nextOp = (clause: FilterClause): FilterClause['op'] => {
  switch (clause.op) {
    case 'before':
      return 'after';
    case 'after':
      return 'before';
    case 'at_least':
      return 'at_most';
    case 'at_most':
      return 'at_least';
    case 'is':
      return ALL_OF_FIELDS.has(clause.field) && clause.values.length > 1
        ? 'all'
        : 'is_not';
    case 'all':
      return 'is_not';
    case 'is_not':
      return 'is';
  }
};

/** How a chip's verb reads. */
const verbOf = (clause: FilterClause): string => {
  const many = clause.values.length > 1;
  if (clause.op === 'before' || clause.op === 'after') {
    return dayBoundChip(clause.op, clause.values[0] ?? '').verb;
  }
  if (clause.op === 'at_least') return 'at least';
  if (clause.op === 'at_most') return 'at most';
  if (isTextField(clause.field)) {
    return clause.op === 'is' ? 'contains' : 'does not contain';
  }
  if (clause.op === 'all') return 'includes all of';
  if (clause.op === 'is') return many ? 'is any of' : 'is';
  return many ? 'is none of' : 'is not';
};

/** The short verb a chip's switch names in its accessible label. */
const verbName = (clause: FilterClause): string => {
  if (clause.op === 'before' || clause.op === 'after') return clause.op;
  if (clause.op === 'at_least') return 'at least';
  if (clause.op === 'at_most') return 'at most';
  if (isTextField(clause.field)) {
    return clause.op === 'is' ? 'contains' : 'does not contain';
  }
  if (clause.op === 'all') return 'includes all of';
  return clause.op === 'is' ? 'is' : 'is not';
};

/** One active filter as a chip. */
const FilterChip: React.FC<{
  clause: FilterClause;
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
}> = ({ clause, filters, context, onChange }) => {
  const triage = useTriageInList(context);
  const choiceContext = useChoiceContext(context, clause.field);
  const dated = clause.op === 'before' || clause.op === 'after';
  const bounded = clause.op === 'at_least' || clause.op === 'at_most';
  const text = isTextField(clause.field);
  const choices =
    dated || bounded || text
      ? []
      : filterChoices(clause.field, choiceContext, triage);
  const names = chosen(clause, choices).map((choice) => choice.option.label);
  const summary =
    clause.op === 'before' || clause.op === 'after'
      ? dayBoundChip(clause.op, clause.values[0] ?? '').summary
      : bounded
        ? numberLabel(clause.field, clause.values[0] ?? '')
        : text
          ? `"${clause.values[0] ?? ''}"`
          : names.length === 0
            ? clause.values.length === 1
              ? '1 value'
              : `${String(clause.values.length)} values`
            : names.length <= 2
              ? names.join(', ')
              : `${String(names.length)} ${FILTER_LABELS[clause.field].toLowerCase()}`;
  const flipped = nextOp(clause);
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
          aria-label={`${FILTER_LABELS[clause.field]} ${verbName(clause)}, switch`}
          disabled={flipTaken}
          onClick={() => {
            replace({ ...clause, op: flipped });
          }}
          className={cn(segment, 'border-r border-line text-text-muted')}
        >
          {verbOf(clause)}
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
        ) : clause.op === 'at_least' || clause.op === 'at_most' ? (
          <NumberValue
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

/** Every part of a filter at once: the flat filters, how they combine, and the groups. */
export interface FilterLogic {
  filters: FilterClause[];
  match: FilterMatch;
  groups: FilterGroup[];
}

/** Props for FilterBar. */
export interface FilterBarProps {
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
  /** The fields this surface filters on, every field when unset. */
  fields?: FilterField[];
  /** How the filters and groups combine, every one of them by default. */
  match?: FilterMatch;
  /** The filter groups, each standing as one filter. */
  groups?: FilterGroup[];
  /** Sets the whole filter at once; a surface without it offers no groups or match switch. */
  onLogicChange?: (logic: FilterLogic) => void;
}

const ADD_GROUP = '__add_group__';

/** The heading the filter keys are listed under in the shortcuts panel. */
export const FILTER_SHORTCUT_GROUP = 'Filters';

/** The keys that drop the filter added last. */
export const REMOVE_LAST_FILTER_KEYS = 'shift+f';

/** The keys that clear every filter. */
export const CLEAR_FILTERS_KEYS = 'alt+shift+f';

/** The filter logic without its newest filter: the last flat filter, else the last group. */
export const withoutLastFilter = (logic: FilterLogic): FilterLogic => {
  if (logic.filters.length > 0) {
    return { ...logic, filters: logic.filters.slice(0, -1) };
  }
  return { ...logic, groups: logic.groups.slice(0, -1) };
};

/** Binds the keys that drop the newest filter and clear them all. */
const useFilterRemovalKeys = ({
  filters,
  match,
  groups,
  onChange,
  onLogicChange,
}: {
  filters: FilterClause[];
  match: FilterMatch;
  groups: FilterGroup[];
  onChange: (filters: FilterClause[]) => void;
  onLogicChange: ((logic: FilterLogic) => void) | undefined;
}): void => {
  const grouped = onLogicChange === undefined ? [] : groups;
  const any = filters.length > 0 || grouped.length > 0;
  useShortcut({
    keys: REMOVE_LAST_FILTER_KEYS,
    label: 'Remove last filter',
    group: FILTER_SHORTCUT_GROUP,
    enabled: any,
    handler: (event) => {
      event?.preventDefault();
      if (onLogicChange === undefined) onChange(filters.slice(0, -1));
      else onLogicChange(withoutLastFilter({ filters, match, groups }));
    },
  });
  useShortcut({
    keys: CLEAR_FILTERS_KEYS,
    label: 'Clear all filters',
    group: FILTER_SHORTCUT_GROUP,
    enabled: any,
    handler: (event) => {
      event?.preventDefault();
      if (onLogicChange === undefined) onChange([]);
      else onLogicChange({ filters: [], match: 'all', groups: [] });
    },
  });
};

/** The field picker that walks from a field to its values, optionally offering a new group. */
const FieldPicker: React.FC<{
  offered: FilterField[];
  filters: FilterClause[];
  context: IssueContext;
  onChange: (filters: FilterClause[]) => void;
  field: FilterField | null;
  onField: (field: FilterField) => void;
  onAddGroup?: () => void;
}> = ({ offered, filters, context, onChange, field, onField, onAddGroup }) =>
  field === null ? (
    <Combobox
      label="Filter by"
      placeholder="Filter by..."
      options={[
        ...offered.map((item) => ({
          value: item,
          label: FILTER_LABELS[item],
          icon: FIELD_ICONS[item],
        })),
        ...(onAddGroup === undefined
          ? []
          : [
              {
                value: ADD_GROUP,
                label: 'Add filter group',
                icon: <LuLayers className="h-3.5 w-3.5" />,
                group: 'Groups',
              },
            ]),
      ]}
      selected={[]}
      onSelect={(value) => {
        if (value === ADD_GROUP) onAddGroup?.();
        else onField(value as FilterField);
      }}
    />
  ) : (
    <ValueList
      field={field}
      filters={filters}
      context={context}
      onChange={onChange}
    />
  );

/**
 * The Filter button that adds a filter, walking from a field to its values; F
 * opens it, Shift F drops the newest filter and Alt Shift F clears them all.
 */
export const FilterButton: React.FC<FilterBarProps> = ({
  filters,
  context,
  onChange,
  fields,
  match = 'all',
  groups = [],
  onLogicChange,
}) => {
  const offered = fields ?? filterFieldsFor(context);
  const [field, setField] = useState<FilterField | null>(null);
  const [open, setOpen] = useState(false);
  useShortcut({
    keys: 'f',
    label: 'Add filter',
    group: FILTER_SHORTCUT_GROUP,
    enabled: !open,
    handler: () => {
      setField(null);
      setOpen(true);
    },
  });
  useFilterRemovalKeys({ filters, match, groups, onChange, onLogicChange });
  const apply = (logic: FilterLogic): void => {
    onLogicChange?.(logic);
  };
  const canGroup =
    onLogicChange !== undefined && groups.length < MAX_FILTER_GROUPS;
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
      <FieldPicker
        offered={offered}
        filters={filters}
        context={context}
        onChange={onChange}
        field={field}
        onField={setField}
        {...(canGroup
          ? {
              onAddGroup: () => {
                apply({
                  filters,
                  match,
                  groups: [...groups, { match: 'any', filters: [] }],
                });
                setOpen(false);
                setField(null);
              },
            }
          : {})}
      />
    </Popover>
  );
};

/** The switch between every condition and any one of them. */
const MatchSwitch: React.FC<{
  match: FilterMatch;
  label: string;
  onChange: (match: FilterMatch) => void;
}> = ({ match, label, onChange }) => (
  <button
    type="button"
    aria-label={`${label} match ${match}, switch`}
    onClick={() => {
      onChange(match === 'all' ? 'any' : 'all');
    }}
    className="h-7 rounded-md border border-line px-2 text-xs text-text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
  >
    {match === 'all' ? 'Match all' : 'Match any'}
  </button>
);

/** One filter group as a box of chips with its own match and its own add button. */
const GroupBox: React.FC<{
  group: FilterGroup;
  index: number;
  offered: FilterField[];
  context: IssueContext;
  onChange: (group: FilterGroup | null) => void;
}> = ({ group, index, offered, context, onChange }) => {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FilterField | null>(null);
  const name = `Filter group ${String(index + 1)}`;
  const setFilters = (filters: FilterClause[]): void => {
    onChange({ ...group, filters });
  };
  return (
    <div
      role="group"
      aria-label={name}
      className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-line p-1"
    >
      <LuLayers
        aria-hidden="true"
        className="ml-1 h-3.5 w-3.5 text-text-faint"
      />
      <MatchSwitch
        match={group.match}
        label={name}
        onChange={(match) => {
          onChange({ ...group, match });
        }}
      />
      {group.filters.map((clause) => (
        <FilterChip
          key={`${clause.field}.${clause.op}`}
          clause={clause}
          filters={group.filters}
          context={context}
          onChange={setFilters}
        />
      ))}
      <Popover
        label={`Add filter to ${name.toLowerCase()}`}
        contentClassName="w-72 p-0"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setField(null);
        }}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            aria-label={`Add filter to ${name.toLowerCase()}`}
            className="flex h-7 items-center rounded-md px-1.5 text-text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        )}
      >
        <FieldPicker
          offered={offered.filter((item) => item !== 'team')}
          filters={group.filters}
          context={context}
          onChange={setFilters}
          field={field}
          onField={setField}
        />
      </Popover>
      <button
        type="button"
        aria-label={`Remove ${name.toLowerCase()}`}
        onClick={() => {
          onChange(null);
        }}
        className="flex h-7 items-center rounded-md px-1.5 text-text-faint hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <LuX aria-hidden="true" className="h-3 w-3" />
      </button>
    </div>
  );
};

/** The active filters as chips, with groups, the match switch and a way to clear them all. */
export const FilterChips: React.FC<FilterBarProps> = ({
  filters,
  context,
  onChange,
  fields,
  match = 'all',
  groups = [],
  onLogicChange,
}) => {
  if (filters.length === 0 && groups.length === 0) return null;
  const offered = fields ?? filterFieldsFor(context);
  const apply = (logic: FilterLogic): void => {
    onLogicChange?.(logic);
  };
  const setGroup = (index: number, next: FilterGroup | null): void => {
    apply({
      filters,
      match,
      groups: groups.flatMap((group, at) =>
        at === index ? (next === null ? [] : [next]) : [group]
      ),
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {onLogicChange !== undefined && filters.length + groups.length > 1 ? (
        <MatchSwitch
          match={match}
          label="Filters"
          onChange={(next) => {
            apply({ filters, match: next, groups });
          }}
        />
      ) : null}
      {filters.map((clause) => (
        <FilterChip
          key={`${clause.field}.${clause.op}`}
          clause={clause}
          filters={filters}
          context={context}
          onChange={onChange}
        />
      ))}
      {onLogicChange === undefined
        ? null
        : groups.map((group, index) => (
            <GroupBox
              key={String(index)}
              group={group}
              index={index}
              offered={offered}
              context={context}
              onChange={(next) => {
                setGroup(index, next);
              }}
            />
          ))}
      <button
        type="button"
        onClick={() => {
          if (onLogicChange === undefined) onChange([]);
          else onLogicChange({ filters: [], match: 'all', groups: [] });
        }}
        className="h-7 rounded-md px-2 text-xs text-text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        Clear
      </button>
    </div>
  );
};
