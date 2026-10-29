/**
 * The values of an issue's properties as palette commands on the issues in
 * focus, the way Linear's command palette offers "Set priority to Urgent" for
 * a typed "urgent". Each value comes from the property's own picker, through
 * {@link propertyChoices}, so a command writes exactly what picking the value
 * in the picker would, with the same undo.
 */

import React from 'react';
import {
  LuBox,
  LuCalendar,
  LuCircleDashed,
  LuIterationCw,
  LuMilestone,
  LuSignal,
  LuTag,
  LuTriangle,
  LuUserRound,
} from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { NONE } from '../../../api/issues';
import type { SubjectValue } from '../../../hooks/useIssueSubject';
import { useTriageTeamIds } from '../../../hooks/useTriageTeams';
import type { ComboboxOption } from '../../ui/combobox';
import type { IssueViewEnv } from './IssueViewContext';
import { propertyChoices } from './propertyChoices';
import type { CommandProperty } from './propertyKeys';

/** The properties the palette offers values of, in the order they list. */
export const VALUE_PROPERTIES = [
  'status',
  'priority',
  'assignee',
  'labels',
  'project',
  'cycle',
  'estimate',
  'milestone',
  'dueDate',
] as const satisfies readonly CommandProperty[];

/** One of the properties the palette offers values of. */
export type ValueProperty = (typeof VALUE_PROPERTIES)[number];

/** The label each property's registered shortcut reads as. */
export const PROPERTY_SHORTCUT_LABELS: Record<ValueProperty, string> = {
  status: 'Change status',
  priority: 'Change priority',
  assignee: 'Assign',
  labels: 'Change labels',
  project: 'Move to project',
  cycle: 'Move to cycle',
  estimate: 'Set estimate',
  milestone: 'Set milestone',
  dueDate: 'Set due date',
};

const ICON = 'h-3.5 w-3.5 shrink-0';

/** The words a property's values are found by beyond their names. */
const KEYWORDS: Record<ValueProperty, string> = {
  status: 'status state workflow',
  priority: 'priority',
  assignee: 'assignee assign owner person',
  labels: 'label tag',
  project: 'project',
  cycle: 'cycle sprint',
  estimate: 'estimate points size',
  milestone: 'milestone project phase',
  dueDate: 'due date deadline',
};

/** The glyph a value shows when its picker draws none. */
const FALLBACK_ICONS: Record<ValueProperty, React.ReactNode> = {
  status: <LuCircleDashed className={ICON} />,
  priority: <LuSignal className={ICON} />,
  assignee: <LuUserRound className={ICON} />,
  labels: <LuTag className={ICON} />,
  project: <LuBox className={ICON} />,
  cycle: <LuIterationCw className={ICON} />,
  estimate: <LuTriangle className={ICON} />,
  milestone: <LuMilestone className={ICON} />,
  dueDate: <LuCalendar className={ICON} />,
};

/** How a value reads as a command, given whether every target already has it. */
const phrase = (
  property: ValueProperty,
  option: ComboboxOption,
  applied: boolean
): string => {
  const clear = option.value === NONE;
  switch (property) {
    case 'status':
      return `Change status to ${option.label}`;
    case 'priority':
      return `Set priority to ${option.label}`;
    case 'assignee':
      return clear ? 'Unassign' : `Assign to ${option.label}`;
    case 'labels':
      return applied
        ? `Remove label ${option.label}`
        : `Add label ${option.label}`;
    case 'project':
      return clear ? 'Remove from project' : `Move to project ${option.label}`;
    case 'cycle':
      return clear ? 'Remove from cycle' : `Move to cycle ${option.label}`;
    case 'estimate':
      return clear ? 'Remove estimate' : `Set estimate to ${option.label}`;
    case 'milestone':
      return clear
        ? 'Remove from milestone'
        : `Set milestone to ${option.label}`;
    case 'dueDate':
      return clear ? 'Remove due date' : `Set due date to ${option.label}`;
  }
};

/** How a value reads in its property's own list in the palette. */
const nameOf = (property: ValueProperty, option: ComboboxOption): string =>
  property === 'dueDate' && option.value === NONE
    ? 'Remove due date'
    : option.label;

/**
 * Whether the issues' milestone can be set: their view names milestones and
 * at least one of them is in a project.
 */
const offersMilestones = (
  issues: readonly OrderedIssueRead[],
  env: IssueViewEnv
): boolean =>
  env.context.milestones !== undefined &&
  issues.some((issue) => issue.project_id !== null);

/** What {@link propertyValues} builds from. */
export interface PropertyValuesInput {
  issues: readonly OrderedIssueRead[];
  env: IssueViewEnv;
  triageTeams: ReadonlySet<string>;
  today: Date;
  /**
   * The term typed in the palette, from which a property such as the due date
   * may read a value of its own, such as the day "nov 3" names.
   */
  query?: string;
}

/**
 * Every value the issues' properties can be set to, as commands. A value
 * every issue already has is checked and marked inert, since running it
 * would change nothing, except a label, which reads as removing it, as its
 * picker does. Removing the due date is offered only while one is set, and
 * a milestone only while an issue is in a project whose milestones the view
 * names. Given a typed term, the due date leads with the day it reads as.
 */
export const propertyValues = ({
  issues,
  env,
  triageTeams,
  today,
  query,
}: PropertyValuesInput): SubjectValue[] => {
  if (issues.length === 0) return [];
  return VALUE_PROPERTIES.flatMap((property) => {
    if (property === 'milestone' && !offersMilestones(issues, env)) return [];
    const choices = propertyChoices({
      property,
      issues,
      env,
      triageTeams,
      today,
      onDone: () => undefined,
    });
    const typed =
      query === undefined || query.trim() === ''
        ? null
        : (choices.leadOption?.(query.trim()) ?? null);
    const taken = new Set<string>();
    const idOf = (option: ComboboxOption, lead: boolean): string => {
      const base = `${property}-${lead ? 'typed-' : ''}${encodeURIComponent(option.value)}`;
      let id = base;
      let copy = 1;
      while (taken.has(id)) {
        copy += 1;
        id = `${base}-${String(copy)}`;
      }
      taken.add(id);
      return id;
    };
    const toValue = (option: ComboboxOption, lead: boolean): SubjectValue[] => {
      if (option.disabled === true) return [];
      const applied = choices.selected.includes(option.value);
      if (property === 'dueDate' && option.value === NONE && applied) return [];
      const inert = applied && !choices.multiple;
      return [
        {
          id: idOf(option, lead),
          label: phrase(property, option, applied),
          name: nameOf(property, option),
          keywords: [KEYWORDS[property], ...(option.keywords ?? [])].join(' '),
          icon: option.icon ?? FALLBACK_ICONS[property],
          property,
          checked: applied,
          inert,
          ...(choices.multiple ? { toggles: true } : {}),
          ...(lead ? { lead: true } : {}),
          ...(property === 'dueDate' && option.detail !== undefined
            ? { detail: option.detail }
            : {}),
          run: () => {
            if (!inert) choices.pick(option.value);
          },
        },
      ];
    };
    return [
      ...(typed === null ? [] : toValue(typed, true)),
      ...choices.options.flatMap((option) => toValue(option, false)),
    ];
  });
};

/**
 * The issues' property values as a getter for the palette, or null when the
 * viewer cannot write them, so the palette offers none.
 */
export const usePropertyValues = (
  issues: readonly OrderedIssueRead[],
  env: IssueViewEnv,
  enabled: boolean
): ((query?: string) => SubjectValue[]) | null => {
  const triageTeams = useTriageTeamIds();
  if (!enabled || issues.length === 0) return null;
  return (query) =>
    propertyValues({
      issues,
      env,
      triageTeams,
      today: new Date(),
      ...(query === undefined ? {} : { query }),
    });
};
