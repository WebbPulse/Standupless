/**
 * The pickers a project's own properties are edited with: status, health,
 * lead, members, labels, teams, an initiative's lead team, update cadence, the projects it waits on or holds up,
 * and its icon and colour. They draw the same `rail` and `chip` triggers as the issue property
 * pickers, so a project reads and edits the way an issue does, and like those
 * they are controlled and write nothing themselves.
 */

import React from 'react';
import {
  LuBellRing,
  LuCheck,
  LuGoal,
  LuTag,
  LuUserRound,
  LuUsers,
} from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { useProjectStatuses } from '../../hooks/useProjectStatuses';
import {
  DEFAULT_PROJECT_STATUSES,
  defaultStatusFor,
  orderProjectStatuses,
  projectStatusOf,
} from '../../lib/projectStatuses';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import {
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_GLYPHS,
  INITIATIVE_STATUS_LABELS,
  PROJECT_UPDATE_INTERVALS,
  PROJECT_UPDATE_INTERVAL_LABELS,
} from '../../lib/planningDisplay';
import {
  PROJECT_COLORS,
  PROJECT_HEALTHS,
  PROJECT_HEALTH_LABELS,
  PROJECT_ICON_GLYPHS,
  PROJECT_ICON_NAMES,
  healthLabel,
} from '../../lib/projectLook';
import {
  BLOCKED_TONE,
  BLOCKING_TONE,
  BlockedGlyph,
  BlockingGlyph,
} from '../issues/RelationGlyphs';
import type {
  InitiativeRead,
  InitiativeStatus,
  ProjectHealth,
  ProjectIconName,
  ProjectLabelRead,
  ProjectRead,
  ProjectRelationType,
  ProjectStatus,
  ProjectUpdateInterval,
  TeamRead,
} from '../../types/Api';
import Avatar from '../ui/avatar';
import { LabelChip } from '../ui/badge';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { Popover, type PopoverTriggerProps } from '../ui/popover';
import ProjectHealthGlyph from './ProjectHealthGlyph';
import ProjectIcon from './ProjectIcon';
import ProjectStatusGlyph from './ProjectStatusGlyph';
import { teamTree } from '../../lib/teamOrder';
import { offeredToTeams } from '../../lib/projectScopes';

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
  /** The chosen status's category. */
  value: ProjectStatus;
  /** The chosen workspace status, its category's default when left out. */
  statusId?: string | null | undefined;
  /**
   * Called with the picked status's category and id, the id left out when the
   * category's default is picked from another category, where a bare category lands.
   */
  onChange: (value: ProjectStatus, statusId?: string) => void;
  percent?: number;
  /** Offer only the six categories, for a template that stores a category. */
  categoriesOnly?: boolean;
  /**
   * The project's teams, whose own statuses join the workspace's; every
   * team's is offered when left out, and none when the list is empty.
   */
  teamIds?: readonly string[] | undefined;
}

/** Picks a project's status from the workspace's, with number keys for the first nine. */
export const ProjectStatusPicker: React.FC<ProjectStatusPickerProps> = ({
  value,
  statusId,
  onChange,
  percent,
  categoriesOnly = false,
  teamIds,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const workspaceStatuses = useProjectStatuses();
  const known = categoriesOnly
    ? DEFAULT_PROJECT_STATUSES
    : orderProjectStatuses(workspaceStatuses.statuses);
  const statuses =
    categoriesOnly || teamIds === undefined
      ? known
      : offeredToTeams(known, teamIds);
  const current = categoriesOnly
    ? defaultStatusFor(known, value)
    : projectStatusOf({ status: value, status_id: statusId }, known);
  const options: ComboboxOption[] = statuses.map((status, index) => ({
    value: status.id,
    label: status.name,
    icon: <ProjectStatusGlyph status={status.category} color={status.color} />,
    ...(index < 9 ? { shortcut: String(index + 1) } : {}),
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
              color={current.color}
              {...(percent === undefined ? {} : { percent })}
            />
          }
          text={current.name}
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
          selected={[current.id]}
          onSelect={(picked) => {
            close();
            const chosen = statuses.find((row) => row.id === picked);
            if (chosen === undefined || chosen.id === current.id) return;
            if (chosen.is_default && chosen.category !== value) {
              onChange(chosen.category);
            } else {
              onChange(chosen.category, chosen.id);
            }
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
  /** What the person is called, Lead for a project and Owner for an initiative. */
  field?: string;
}

/** Picks the person leading a project, or nobody. */
export const LeadPicker: React.FC<LeadPickerProps> = ({
  value,
  people,
  onChange,
  field = 'Lead',
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const lead = people.find((person) => person.user_id === value);
  const options: ComboboxOption[] = [
    {
      value: '',
      label: `No ${field.toLowerCase()}`,
      icon: <LuUserRound className="h-3.5 w-3.5" />,
    },
    ...people.map((person) => ({
      value: person.user_id,
      label: personLabel(person),
      icon: (
        <Avatar
          name={personLabel(person)}
          src={personAvatar(person)}
          size="xs"
        />
      ),
      keywords: [person.email],
    })),
  ];
  const text =
    value === null
      ? variant === 'chip'
        ? field
        : `No ${field.toLowerCase()}`
      : lead === undefined
        ? 'Unknown'
        : personLabel(lead);
  return (
    <Popover
      label={field}
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field={field}
          icon={
            lead === undefined ? (
              <LuUserRound className="h-3.5 w-3.5" />
            ) : (
              <Avatar
                name={personLabel(lead)}
                src={personAvatar(lead)}
                size="xs"
              />
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
          label={field}
          placeholder={`Set ${field.toLowerCase()}`}
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
  const options: ComboboxOption[] = teamTree(teams).map(
    ({ team, nested, parentName }) => ({
      value: team.id,
      label: team.name,
      detail: team.key_prefix,
      icon: <TeamKey keyPrefix={team.key_prefix} />,
      disabled: value.length === 1 && value[0] === team.id,
      indent: nested,
      ...(parentName === undefined ? {} : { keywords: [parentName] }),
    })
  );
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

/** Props for LeadTeamPicker: the teams that may lead and the chosen one. */
export interface LeadTeamPickerProps extends ProjectPickerBaseProps {
  value: string | null;
  teams: TeamRead[];
  onChange: (value: string | null) => void;
}

/** The option value for an initiative no team leads. */
const NO_LEAD_TEAM = '';

/**
 * Picks the one team leading an initiative, or none for a workspace level one.
 * A private team hides the initiative from everyone outside it.
 */
export const LeadTeamPicker: React.FC<LeadTeamPickerProps> = ({
  value,
  teams,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const chosen = teams.find((team) => team.id === value);
  const options: ComboboxOption[] = [
    {
      value: NO_LEAD_TEAM,
      label: 'No team',
      icon: <LuUsers className="h-3.5 w-3.5" />,
    },
    ...teamTree(teams).map(({ team, nested, parentName }) => ({
      value: team.id,
      label: team.name,
      icon: <TeamKey keyPrefix={team.key_prefix} />,
      indent: nested,
      keywords: [
        team.key_prefix,
        ...(parentName === undefined ? [] : [parentName]),
      ],
    })),
  ];
  const text =
    value === null
      ? variant === 'chip'
        ? 'Team'
        : 'No team'
      : (chosen?.name ?? 'Private team');
  return (
    <Popover
      label="Team"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Team"
          icon={
            chosen === undefined ? (
              <LuUsers className="h-3.5 w-3.5" />
            ) : (
              <TeamKey keyPrefix={chosen.key_prefix} />
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
          label="Team"
          placeholder="Set team"
          options={options}
          selected={[value ?? NO_LEAD_TEAM]}
          emptyMessage="No team matches"
          onSelect={(picked) => {
            close();
            const next = picked === NO_LEAD_TEAM ? null : picked;
            if (next !== value) onChange(next);
          }}
        />
      )}
    </Popover>
  );
};

/** Props for DependencyPicker: which side, the linked projects and the candidates. */
export interface DependencyPickerProps extends ProjectPickerBaseProps {
  /** `blocked_by` for the projects this one waits on, `blocks` for the ones it holds up. */
  type: ProjectRelationType;
  /** The linked project ids on this side. */
  value: string[];
  /** Every project that may be linked, the project itself already left out. */
  candidates: ProjectRead[];
  /** The project ids linked the other way, offered disabled. */
  opposite?: string[];
  /** Links the picked project, or unlinks it when it is already linked. */
  onToggle: (projectId: string) => void;
}

/**
 * Picks the projects this one is blocked by, or the ones it blocks, several at
 * once. A project already linked the other way is offered disabled, since the
 * same pair cannot wait on each other.
 */
export const DependencyPicker: React.FC<DependencyPickerProps> = ({
  type,
  value,
  candidates,
  opposite = [],
  onToggle,
  disabled = false,
  variant = 'chip',
  align = 'start',
  className = '',
}) => {
  const { statusOf } = useProjectStatuses();
  const field = type === 'blocked_by' ? 'Blocked by' : 'Blocking';
  const Glyph = type === 'blocked_by' ? BlockedGlyph : BlockingGlyph;
  const tone = type === 'blocked_by' ? BLOCKED_TONE : BLOCKING_TONE;
  const chosen = candidates.filter((project) =>
    value.includes(project.project_id)
  );
  const options: ComboboxOption[] = candidates.map((project) => ({
    value: project.project_id,
    label: project.name,
    detail: statusOf(project).name,
    icon: <ProjectIcon icon={project.icon} color={project.color} />,
    disabled: opposite.includes(project.project_id),
  }));
  const count = value.length;
  const text =
    count === 0
      ? variant === 'chip'
        ? field
        : type === 'blocked_by'
          ? 'Not blocked'
          : 'Blocks nothing'
      : count === 1
        ? `${field} ${chosen[0]?.name ?? '1 project'}`
        : `${field} ${String(count)} projects`;
  return (
    <Popover
      label={field}
      align={align}
      block={variant === 'rail'}
      contentClassName="w-72"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field={field}
          icon={<Glyph className={cn('h-3.5 w-3.5', count > 0 && tone)} />}
          text={text}
          empty={count === 0}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      <Combobox
        label={field}
        placeholder={
          type === 'blocked_by'
            ? 'Mark as blocked by a project'
            : 'Mark as blocking a project'
        }
        multiple
        options={options}
        selected={value}
        onSelect={onToggle}
      />
    </Popover>
  );
};

/** Props for InitiativeStatusPicker: the chosen initiative status. */
export interface InitiativeStatusPickerProps extends ProjectPickerBaseProps {
  value: InitiativeStatus;
  onChange: (value: InitiativeStatus) => void;
}

/** Picks an initiative's status, with number keys for each choice. */
export const InitiativeStatusPicker: React.FC<InitiativeStatusPickerProps> = ({
  value,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const options: ComboboxOption[] = INITIATIVE_STATUSES.map(
    (status, index) => ({
      value: status,
      label: INITIATIVE_STATUS_LABELS[status],
      icon: <ProjectStatusGlyph status={INITIATIVE_STATUS_GLYPHS[status]} />,
      shortcut: String(index + 1),
    })
  );
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
          icon={<ProjectStatusGlyph status={INITIATIVE_STATUS_GLYPHS[value]} />}
          text={INITIATIVE_STATUS_LABELS[value]}
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
            if (picked !== value) onChange(picked as InitiativeStatus);
          }}
        />
      )}
    </Popover>
  );
};

/** Props for InitiativePicker: the initiatives to choose from and the chosen one. */
export interface InitiativePickerProps extends ProjectPickerBaseProps {
  value: string | null;
  initiatives: InitiativeRead[];
  onChange: (value: string | null) => void;
  /** What the picker names, "Initiative" for a project and "Parent" for an initiative. */
  field?: string;
  /** The name the chosen initiative reads as while the list has not loaded it. */
  valueName?: string | null;
}

/** The option value that takes a project out of its initiative. */
const NO_INITIATIVE = '';

/** Picks the initiative a project belongs to, or none. */
export const InitiativePicker: React.FC<InitiativePickerProps> = ({
  value,
  initiatives,
  onChange,
  field = 'Initiative',
  valueName = null,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const chosen = initiatives.find(
    (initiative) => initiative.initiative_id === value
  );
  const options: ComboboxOption[] = [
    {
      value: NO_INITIATIVE,
      label: `No ${field.toLowerCase()}`,
      icon: <LuGoal className="h-3.5 w-3.5" />,
    },
    ...initiatives.map((initiative) => ({
      value: initiative.initiative_id,
      label: initiative.name,
      icon: (
        <ProjectStatusGlyph
          status={INITIATIVE_STATUS_GLYPHS[initiative.status]}
        />
      ),
    })),
  ];
  const text =
    value === null
      ? variant === 'chip'
        ? field
        : `No ${field.toLowerCase()}`
      : (chosen?.name ?? valueName ?? 'Unknown');
  return (
    <Popover
      label={field}
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field={field}
          icon={<LuGoal className="h-3.5 w-3.5" />}
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
          label={field}
          placeholder={`Set ${field.toLowerCase()}`}
          options={options}
          selected={[value ?? NO_INITIATIVE]}
          emptyMessage={`No ${field.toLowerCase()} matches`}
          onSelect={(picked) => {
            close();
            const next = picked === NO_INITIATIVE ? null : picked;
            if (next !== value) onChange(next);
          }}
        />
      )}
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

/** Props for CadencePicker: the cadence the project follows and whether it is inherited. */
export interface CadencePickerProps extends ProjectPickerBaseProps {
  value: ProjectUpdateInterval;
  inherited: boolean;
  /** The workspace default a project without its own follows. */
  workspaceDefault: ProjectUpdateInterval;
  /** Called with the chosen cadence, or null to follow the workspace again. */
  onChange: (value: ProjectUpdateInterval | null) => void;
}

/** The option value that returns a project to the workspace cadence. */
const INHERIT_CADENCE = 'inherit';

/** Picks how often the lead is reminded to post an update, or the workspace default. */
export const CadencePicker: React.FC<CadencePickerProps> = ({
  value,
  inherited,
  workspaceDefault,
  onChange,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const options: ComboboxOption[] = [
    {
      value: INHERIT_CADENCE,
      label: `Workspace default (${PROJECT_UPDATE_INTERVAL_LABELS[workspaceDefault]})`,
    },
    ...PROJECT_UPDATE_INTERVALS.map((interval) => ({
      value: String(interval),
      label: PROJECT_UPDATE_INTERVAL_LABELS[interval],
    })),
  ];
  const text =
    value === 0
      ? 'No update reminders'
      : `Updates ${PROJECT_UPDATE_INTERVAL_LABELS[value].toLowerCase()}`;
  return (
    <Popover
      label="Update cadence"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <Trigger
          trigger={trigger}
          field="Update cadence"
          icon={<LuBellRing className="h-3.5 w-3.5" />}
          text={text}
          empty={value === 0}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      {(close) => (
        <Combobox
          label="Update cadence"
          placeholder="Remind the lead"
          options={options}
          selected={[inherited ? INHERIT_CADENCE : String(value)]}
          onSelect={(picked) => {
            close();
            if (picked === INHERIT_CADENCE) {
              if (!inherited) onChange(null);
              return;
            }
            const next = Number(picked) as ProjectUpdateInterval;
            if (inherited || next !== value) onChange(next);
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
    icon: (
      <Avatar name={personLabel(person)} src={personAvatar(person)} size="xs" />
    ),
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
              <Avatar
                name={personLabel(first)}
                src={personAvatar(first)}
                size="xs"
              />
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

/** Props for ProjectLabelsPicker: the workspace's project labels and the chosen ones. */
export interface ProjectLabelsPickerProps extends ProjectPickerBaseProps {
  value: string[];
  labels: ProjectLabelRead[];
  onChange: (value: string[]) => void;
  /**
   * The project's teams, whose own labels join the workspace's; every team's
   * is offered when left out. A chosen label outside them still shows.
   */
  teamIds?: readonly string[] | undefined;
  /**
   * Draws the chosen labels as chips in place of the field trigger, as a list
   * row or board card shows them; nothing is drawn when none is chosen and
   * the picker is disabled.
   */
  inline?: boolean;
}

/** Picks a project's labels from the workspace's project labels, several at once. */
export const ProjectLabelsPicker: React.FC<ProjectLabelsPickerProps> = ({
  value,
  labels,
  onChange,
  teamIds,
  inline = false,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const byId = new Map(labels.map((label) => [label.id, label]));
  const chosen = value
    .map((id) => byId.get(id))
    .filter((label): label is ProjectLabelRead => label !== undefined);
  const offered =
    teamIds === undefined ? labels : offeredToTeams(labels, teamIds);
  const options: ComboboxOption[] = [
    ...offered,
    ...chosen.filter((label) => !offered.includes(label)),
  ].map((label) => ({
    value: label.id,
    label: label.name,
    icon: (
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color }}
      />
    ),
  }));
  const first = chosen[0];
  const text =
    chosen.length === 0
      ? variant === 'chip'
        ? 'Labels'
        : 'No labels'
      : chosen.length === 1 && first !== undefined
        ? first.name
        : `${String(chosen.length)} labels`;
  if (inline && disabled && chosen.length === 0) return null;
  return (
    <Popover
      label="Labels"
      align={align}
      block={variant === 'rail' && !inline}
      contentClassName="w-64"
      trigger={(trigger) =>
        inline ? (
          <button
            type="button"
            disabled={disabled}
            aria-label={`Labels: ${chosen.length === 0 ? 'No labels' : chosen.map((label) => label.name).join(', ')}`}
            {...trigger}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              trigger.onClick();
            }}
            className={cn(
              'inline-flex min-w-0 items-center gap-1 rounded-sm hover:opacity-80 disabled:cursor-default disabled:hover:opacity-100',
              className
            )}
          >
            {chosen.length === 0 ? (
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-line text-text-faint">
                <LuTag aria-hidden="true" className="h-3 w-3" />
              </span>
            ) : (
              chosen.map((label) => (
                <LabelChip
                  key={label.id}
                  color={label.color}
                  name={label.name}
                  reveal={false}
                  className="max-w-32"
                />
              ))
            )}
          </button>
        ) : (
          <Trigger
            trigger={trigger}
            field="Labels"
            icon={
              chosen.length === 1 && first !== undefined ? (
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: first.color }}
                />
              ) : (
                <LuTag className="h-3.5 w-3.5" />
              )
            }
            text={text}
            empty={chosen.length === 0}
            variant={variant}
            disabled={disabled}
            className={className}
          />
        )
      }
    >
      <Combobox
        label="Labels"
        placeholder="Add labels"
        multiple
        options={options}
        selected={value}
        emptyMessage={
          offered.length === 0
            ? 'No project labels yet. Add them in workspace or team settings.'
            : 'No label matches'
        }
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
            'h-5 w-5 rounded-full border border-line-strong bg-raised transition-shadow duration-100 active:scale-95',
            color === null
              ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg'
              : 'hover:ring-2 hover:ring-line-strong hover:ring-offset-1 hover:ring-offset-bg'
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
              'inline-flex h-5 w-5 items-center justify-center rounded-full text-white transition-shadow duration-100 active:scale-95',
              color === swatch
                ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg'
                : 'hover:ring-2 hover:ring-line-strong hover:ring-offset-1 hover:ring-offset-bg'
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
