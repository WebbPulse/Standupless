/**
 * The pickers a project's own properties are edited with: status, lead and
 * teams. They draw the same `rail` and `chip` triggers as the issue property
 * pickers, so a project reads and edits the way an issue does, and like those
 * they are controlled and write nothing themselves.
 */

import React from 'react';
import { LuUserRound, LuUsers } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import type { ProjectStatus, TeamRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Popover, type PopoverTriggerProps } from '../ui/popover';
import ProjectStatusGlyph from './ProjectStatusGlyph';

/** Which trigger look a project picker draws. */
export type ProjectPickerVariant = 'rail' | 'chip' | 'icon';

/** The props every project picker shares. */
export interface ProjectPickerBaseProps {
  disabled?: boolean;
  variant?: ProjectPickerVariant;
  align?: 'start' | 'end';
  className?: string;
}

const TRIGGER_CLASS: Record<ProjectPickerVariant, string> = {
  rail: 'min-h-7 w-full justify-start gap-2 rounded-sm px-2 py-1 text-sm text-text enabled:hover:bg-raised',
  chip: 'h-7 max-w-56 gap-1.5 rounded-sm border border-line px-2 text-xs text-text enabled:hover:border-line-strong enabled:hover:bg-raised',
  icon: 'h-6 w-6 justify-center rounded-sm text-text-muted enabled:hover:bg-raised',
};

interface TriggerProps {
  trigger: PopoverTriggerProps;
  field: string;
  icon: React.ReactNode;
  text: string;
  empty: boolean;
  variant: ProjectPickerVariant;
  disabled: boolean;
  className: string;
}

/** The control a project picker opens from, named "Field: value". */
const Trigger: React.FC<TriggerProps> = ({
  trigger,
  field,
  icon,
  text,
  empty,
  variant,
  disabled,
  className,
}) => (
  <button
    type="button"
    disabled={disabled}
    aria-label={`${field}: ${text}`}
    {...trigger}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      trigger.onClick();
    }}
    className={cn(
      'inline-flex min-w-0 shrink-0 items-center text-left transition-colors duration-100 select-none disabled:cursor-default',
      TRIGGER_CLASS[variant],
      className
    )}
  >
    <span
      aria-hidden="true"
      className="flex w-4 shrink-0 items-center justify-center text-text-muted"
    >
      {icon}
    </span>
    <span
      className={cn(
        variant === 'icon' ? 'sr-only' : 'min-w-0 truncate',
        empty && 'text-text-muted'
      )}
    >
      {text}
    </span>
  </button>
);

/** Props for ProjectStatusPicker: the chosen status and its progress. */
export interface ProjectStatusPickerProps extends ProjectPickerBaseProps {
  value: ProjectStatus;
  onChange: (value: ProjectStatus) => void;
  percent?: number;
}

/** Picks a project's status, with number keys for each choice. */
export const ProjectStatusPicker: React.FC<ProjectStatusPickerProps> = ({
  value,
  onChange,
  percent,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const options: ComboboxOption[] = PROJECT_STATUSES.map((status, index) => ({
    value: status,
    label: PROJECT_STATUS_LABELS[status],
    icon: <ProjectStatusGlyph status={status} />,
    shortcut: String(index + 1),
  }));
  return (
    <Popover
      label="Status"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-56"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Status"
          icon={
            <ProjectStatusGlyph
              status={value}
              {...(percent === undefined ? {} : { percent })}
            />
          }
          text={PROJECT_STATUS_LABELS[value]}
          empty={false}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      {(close) => (
        <Combobox
          label="Status"
          placeholder="Change status"
          options={options}
          selected={[value]}
          onSelect={(picked) => {
            close();
            if (picked !== value) onChange(picked as ProjectStatus);
          }}
        />
      )}
    </Popover>
  );
};

/** Props for LeadPicker: the people who may lead and the chosen one. */
export interface LeadPickerProps extends ProjectPickerBaseProps {
  value: string | null;
  people: Assignable[];
  onChange: (value: string | null) => void;
}

/** Picks the person leading a project, or nobody. */
export const LeadPicker: React.FC<LeadPickerProps> = ({
  value,
  people,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const lead = people.find((person) => person.user_id === value);
  const options: ComboboxOption[] = [
    {
      value: '',
      label: 'No lead',
      icon: <LuUserRound className="h-3.5 w-3.5" />,
    },
    ...people.map((person) => ({
      value: person.user_id,
      label: personLabel(person),
      icon: <Avatar name={personLabel(person)} size="xs" />,
      keywords: [person.email],
    })),
  ];
  const text =
    value === null
      ? variant === 'chip'
        ? 'Lead'
        : 'No lead'
      : lead === undefined
        ? 'Unknown'
        : personLabel(lead);
  return (
    <Popover
      label="Lead"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Lead"
          icon={
            lead === undefined ? (
              <LuUserRound className="h-3.5 w-3.5" />
            ) : (
              <Avatar name={personLabel(lead)} size="xs" />
            )
          }
          text={text}
          empty={value === null}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      {(close) => (
        <Combobox
          label="Lead"
          placeholder="Set lead"
          options={options}
          selected={[value ?? '']}
          emptyMessage="Nobody matches"
          onSelect={(picked) => {
            close();
            const next = picked === '' ? null : picked;
            if (next !== value) onChange(next);
          }}
        />
      )}
    </Popover>
  );
};

/** Props for TeamsPicker: the teams on offer and the chosen ones. */
export interface TeamsPickerProps extends ProjectPickerBaseProps {
  value: string[];
  teams: TeamRead[];
  onChange: (value: string[]) => void;
}

/** How a team's key reads as a small square chip. */
export const TeamKey: React.FC<{ keyPrefix: string; className?: string }> = ({
  keyPrefix,
  className = '',
}) => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-xs bg-raised px-1 font-mono text-[9px] font-semibold text-text-muted',
      className
    )}
  >
    {keyPrefix}
  </span>
);

/**
 * Picks the teams a project belongs to, several at once. The last team cannot
 * be taken off, because a project always belongs to at least one.
 */
export const TeamsPicker: React.FC<TeamsPickerProps> = ({
  value,
  teams,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const chosen = teams.filter((team) => value.includes(team.id));
  const options: ComboboxOption[] = teams.map((team) => ({
    value: team.id,
    label: team.name,
    detail: team.key_prefix,
    icon: <TeamKey keyPrefix={team.key_prefix} />,
    disabled: value.length === 1 && value[0] === team.id,
  }));
  const text =
    chosen.length === 0
      ? variant === 'chip'
        ? 'Teams'
        : 'No teams'
      : chosen.length === 1
        ? (chosen[0]?.name ?? '')
        : `${String(chosen.length)} teams`;
  return (
    <Popover
      label="Teams"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Teams"
          icon={
            chosen.length === 1 && chosen[0] !== undefined ? (
              <TeamKey keyPrefix={chosen[0].key_prefix} />
            ) : (
              <LuUsers className="h-3.5 w-3.5" />
            )
          }
          text={text}
          empty={chosen.length === 0}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      <Combobox
        label="Teams"
        placeholder="Add teams"
        multiple
        options={options}
        selected={value}
        onSelect={(picked) => {
          onChange(
            value.includes(picked)
              ? value.filter((id) => id !== picked)
              : [...value, picked]
          );
        }}
      />
    </Popover>
  );
};

export default ProjectStatusPicker;
