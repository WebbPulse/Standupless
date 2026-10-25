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
  LuCircleDashed,
  LuIterationCw,
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
  }
};

/** What {@link propertyValues} builds from. */
export interface PropertyValuesInput {
  issues: readonly OrderedIssueRead[];
  env: IssueViewEnv;
  triageTeams: ReadonlySet<string>;
  today: Date;
}

/**
 * Every value the issues' properties can be set to, as commands. A value
 * every issue already has is checked and marked inert, since running it
 * would change nothing, except a label, which reads as removing it, as its
 * picker does.
 */
export const propertyValues = ({
  issues,
  env,
  triageTeams,
  today,
}: PropertyValuesInput): SubjectValue[] => {
  if (issues.length === 0) return [];
  return VALUE_PROPERTIES.flatMap((property) => {
    const choices = propertyChoices({
      property,
      issues,
      env,
      triageTeams,
      today,
      onDone: () => undefined,
    });
    return choices.options.flatMap((option) => {
      if (option.disabled === true) return [];
      const applied = choices.selected.includes(option.value);
      const inert = applied && !choices.multiple;
      return [
        {
          id: `${property}-${encodeURIComponent(option.value)}`,
          label: phrase(property, option, applied),
          name: option.label,
          keywords: [KEYWORDS[property], ...(option.keywords ?? [])].join(' '),
          icon: option.icon ?? FALLBACK_ICONS[property],
          property,
          checked: applied,
          inert,
          run: () => {
            if (!inert) choices.pick(option.value);
          },
        },
      ];
    });
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
): (() => SubjectValue[]) | null => {
  const triageTeams = useTriageTeamIds();
  if (!enabled || issues.length === 0) return null;
  return () => propertyValues({ issues, env, triageTeams, today: new Date() });
};
