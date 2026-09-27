/**
 * The pickers a project's own properties are edited with: status, health,
 * lead, members, teams and its icon and colour. They draw the same `rail` and `chip` triggers as the issue property
 * pickers, so a project reads and edits the way an issue does, and like those
 * they are controlled and write nothing themselves.
 */

import React from 'react';
import { LuCheck, LuUserRound, LuUsers } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import {
  PROJECT_COLORS,
  PROJECT_HEALTHS,
  PROJECT_HEALTH_LABELS,
  PROJECT_ICON_GLYPHS,
  PROJECT_ICON_NAMES,
  healthLabel,
} from '../../lib/projectLook';
import type {
  ProjectHealth,
  ProjectIconName,
  ProjectStatus,
  TeamRead,
} from '../../types/Api';
import Avatar from '../ui/avatar';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Popover, type PopoverTriggerProps } from '../ui/popover';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import ProjectIcon from './ProjectIcon';
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

/** Props for HealthPicker: the project's health, or none yet. */
export interface HealthPickerProps extends ProjectPickerBaseProps {
  value: ProjectHealth | null;
  onChange: (value: ProjectHealth | null) => void;
}

/** The option value that clears a project's health. */
const NO_HEALTH = '';

/** Picks how a project is tracking, or clears it back to no updates. */
export const HealthPicker: React.FC<HealthPickerProps> = ({
  value,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const options: ComboboxOption[] = [
    ...PROJECT_HEALTHS.map((health, index) => ({
      value: health,
      label: PROJECT_HEALTH_LABELS[health],
      icon: <ProjectHealthGlyph health={health} />,
      shortcut: String(index + 1),
    })),
    {
      value: NO_HEALTH,
      label: 'No updates',
      icon: <ProjectHealthGlyph health={null} />,
    },
  ];
  return (
    <Popover
      label="Health"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-56"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Health"
          icon={<ProjectHealthGlyph health={value} />}
          text={healthLabel(value)}
          empty={value === null}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      {(close) => (
        <Combobox
          label="Health"
          placeholder="Set health"
          options={options}
          selected={[value ?? NO_HEALTH]}
          onSelect={(picked) => {
            close();
            const next =
              picked === NO_HEALTH ? null : (picked as ProjectHealth);
            if (next !== value) onChange(next);
          }}
        />
      )}
    </Popover>
  );
};

/** Props for MembersPicker: the people on offer and the chosen members. */
export interface MembersPickerProps extends ProjectPickerBaseProps {
  value: string[];
  people: Assignable[];
  onChange: (value: string[]) => void;
}

/** Picks the people working on a project, several at once. */
export const MembersPicker: React.FC<MembersPickerProps> = ({
  value,
  people,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const chosen = people.filter((person) => value.includes(person.user_id));
  const options: ComboboxOption[] = people.map((person) => ({
    value: person.user_id,
    label: personLabel(person),
    icon: <Avatar name={personLabel(person)} size="xs" />,
    keywords: [person.email],
  }));
  const first = chosen[0];
  const text =
    value.length === 0
      ? variant === 'chip'
        ? 'Members'
        : 'No members'
      : value.length === 1 && first !== undefined
        ? personLabel(first)
        : `${String(value.length)} members`;
  return (
    <Popover
      label="Members"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Members"
          icon={
            value.length === 1 && first !== undefined ? (
              <Avatar name={personLabel(first)} size="xs" />
            ) : (
              <LuUsers className="h-3.5 w-3.5" />
            )
          }
          text={text}
          empty={value.length === 0}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      <Combobox
        label="Members"
        placeholder="Add members"
        multiple
        options={options}
        selected={value}
        emptyMessage="Nobody matches"
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

/** Props for ProjectLookPicker: the project's icon and colour. */
export interface ProjectLookPickerProps {
  icon: ProjectIconName | null;
  color: string | null;
  onChange: (patch: {
    icon?: ProjectIconName | null;
    color?: string | null;
  }) => void;
  disabled?: boolean;
  align?: 'start' | 'end';
  className?: string;
}

/**
 * Picks a project's icon and colour from a grid of glyphs and a row of
 * swatches. The trigger is the project's own mark, so clicking the icon is
 * how it is changed.
 */
export const ProjectLookPicker: React.FC<ProjectLookPickerProps> = ({
  icon,
  color,
  onChange,
  disabled = false,
  align = 'start',
  className = '',
}) => (
  <Popover
    label="Icon and colour"
    align={align}
    contentClassName="w-64 p-2"
    trigger={(trigger) => (
      <button
        type="button"
        disabled={disabled}
        aria-label="Icon and colour"
        {...trigger}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          trigger.onClick();
        }}
        className="inline-flex rounded-sm focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none enabled:hover:opacity-80 disabled:cursor-default"
      >
        <ProjectIcon icon={icon} color={color} className={className} />
      </button>
    )}
  >
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label="Colour"
        className="flex flex-wrap gap-1.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={color === null}
          aria-label="No colour"
          onClick={() => {
            if (color !== null) onChange({ color: null });
          }}
          className={cn(
            'h-5 w-5 rounded-full border border-line-strong bg-raised',
            color === null && 'ring-2 ring-accent ring-offset-1 ring-offset-bg'
          )}
        />
        {PROJECT_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            role="radio"
            aria-checked={color === swatch}
            aria-label={`Colour ${swatch}`}
            onClick={() => {
              if (color !== swatch) onChange({ color: swatch });
            }}
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded-full text-white',
              color === swatch &&
                'ring-2 ring-accent ring-offset-1 ring-offset-bg'
            )}
            style={{ backgroundColor: swatch }}
          >
            {color === swatch && <LuCheck className="h-3 w-3" />}
          </button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label="Icon"
        className="grid grid-cols-8 gap-1 border-t border-line pt-2"
      >
        {PROJECT_ICON_NAMES.map((name) => {
          const picked = (icon ?? 'box') === name;
          return (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={picked}
              aria-label={`Icon ${name}`}
              onClick={() => {
                if (icon !== name) onChange({ icon: name });
              }}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-sm text-text-muted hover:bg-raised hover:text-text',
                picked && 'bg-raised text-text'
              )}
              style={picked && color !== null ? { color } : undefined}
            >
              {React.createElement(PROJECT_ICON_GLYPHS[name], {
                className: 'h-4 w-4',
              })}
            </button>
          );
        })}
      </div>
    </div>
  </Popover>
);

export default ProjectStatusPicker;
