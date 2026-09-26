/**
 * The inline property pickers an issue is edited with: a trigger showing the
 * current value, opening a searchable list in a popover. Every issue surface
 * uses these same controls, the detail rail, the peek pane, the new issue
 * dialog and the list and board rows, so a person learns one way of changing
 * a status and it works everywhere.
 *
 * Each picker is controlled and writes nothing itself. It reports the chosen
 * value, and the surface decides whether that is a local draft or an
 * optimistic write. Three trigger looks cover the surfaces: `rail` for a full
 * width property row, `chip` for the bordered chips along a dialog footer, and
 * `icon` for a dense row where only the glyph fits.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  LuBox,
  LuCalendar,
  LuCircleDashed,
  LuCornerUpLeft,
  LuIterationCw,
  LuTag,
  LuTriangle,
  LuUserRound,
  LuX,
} from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import {
  CYCLE_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
} from '../../lib/planningDisplay';
import {
  STATUS_CATEGORY_LABELS,
  dateInRange,
  datePresets,
  shortDateLabel,
  sortStatuses,
} from '../../lib/propertyOptions';
import {
  DATE_PATTERN,
  estimateChoices,
  validateDateRange,
} from '../../lib/validation';
import type {
  CycleRead,
  EstimateScale,
  IssuePriority,
  IssueRead,
  LabelRead,
  ProjectRead,
  StatusRead,
} from '../../types/Api';
import Avatar from '../ui/avatar';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { PriorityGlyph, StatusGlyph } from '../ui/glyphs';
import { Popover, type PopoverTriggerProps } from '../ui/popover';

/** Which trigger look a picker draws. */
export type PickerVariant = 'rail' | 'chip' | 'icon';

/** The props every picker shares, whatever it picks. */
export interface PickerBaseProps {
  /** Shows the value without letting it change, for a read only caller. */
  disabled?: boolean;
  variant?: PickerVariant;
  /** Which edge of the trigger the list lines up with. */
  align?: 'start' | 'end';
  className?: string;
}

/** The value the "none" row carries in a list that can be cleared. */
const NONE = '';

const TRIGGER_CLASS: Record<PickerVariant, string> = {
  rail: 'min-h-7 w-full justify-start gap-2 rounded-sm px-2 py-1 text-sm text-text enabled:hover:bg-raised',
  chip: 'h-7 max-w-56 gap-1.5 rounded-sm border border-line px-2 text-xs text-text enabled:hover:border-line-strong enabled:hover:bg-raised',
  icon: 'h-6 w-6 justify-center rounded-sm text-text-muted enabled:hover:bg-raised',
};

interface PickerButtonProps {
  trigger: PopoverTriggerProps;
  field: string;
  icon?: React.ReactNode;
  text: React.ReactNode;
  /** What a screen reader hears for the value when `text` is not a string. */
  spoken?: string;
  empty: boolean;
  variant: PickerVariant;
  disabled: boolean;
  className: string;
}

/**
 * The control a picker opens from. Its name is the field and the value,
 * "Status: In progress", so a screen reader user hears both without the
 * visible row label being read twice.
 */
const PickerButton: React.FC<PickerButtonProps> = ({
  trigger,
  field,
  icon,
  text,
  spoken,
  empty,
  variant,
  disabled,
  className,
}) => (
  <button
    type="button"
    disabled={disabled}
    aria-label={`${field}: ${spoken ?? (typeof text === 'string' ? text : '')}`}
    {...trigger}
    className={cn(
      'inline-flex min-w-0 shrink-0 items-center text-left transition-colors duration-100 select-none disabled:cursor-default',
      TRIGGER_CLASS[variant],
      className
    )}
  >
    {icon !== undefined && (
      <span
        aria-hidden="true"
        className="flex w-4 shrink-0 items-center justify-center text-text-muted"
      >
        {icon}
      </span>
    )}
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

interface SinglePickerProps extends PickerBaseProps {
  field: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  icon?: React.ReactNode;
  text: React.ReactNode;
  empty: boolean;
  placeholder: string;
  footer?: (close: () => void) => React.ReactNode;
}

/** A trigger and a single choice list, closing on the pick. */
const SinglePicker: React.FC<SinglePickerProps> = ({
  field,
  options,
  value,
  onChange,
  icon,
  text,
  empty,
  placeholder,
  footer,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => (
  <Popover
    label={field}
    align={align}
    block={variant === 'rail'}
    contentClassName="w-64"
    trigger={(trigger) => (
      <PickerButton
        trigger={trigger}
        field={field}
        icon={icon}
        text={text}
        empty={empty}
        variant={variant}
        disabled={disabled}
        className={className}
      />
    )}
  >
    {(close) => (
      <Combobox
        label={field}
        placeholder={placeholder}
        options={options}
        selected={[value]}
        onSelect={(picked) => {
          close();
          if (picked !== value) onChange(picked);
        }}
        footer={footer?.(close)}
      />
    )}
  </Popover>
);

/** The text an empty picker shows: the field on a chip, a phrase elsewhere. */
const emptyText = (
  variant: PickerVariant,
  field: string,
  phrase: string
): string => (variant === 'chip' ? field : phrase);

/** Props for StatusPicker: the team's statuses and the chosen one. */
export interface StatusPickerProps extends PickerBaseProps {
  statuses: StatusRead[];
  /** The chosen status id, or null for the team default. */
  value: string | null;
  onChange: (statusId: string) => void;
}

/**
 * Picks a workflow status. The list is grouped by category in workflow
 * order, and the number keys pick the first nine without typing.
 */
export const StatusPicker: React.FC<StatusPickerProps> = ({
  statuses,
  value,
  onChange,
  ...base
}) => {
  const ordered = sortStatuses(statuses);
  const current = statuses.find((status) => status.id === value);
  const options: ComboboxOption[] = ordered.map((status, index) => ({
    value: status.id,
    label: status.name,
    icon: <StatusGlyph category={status.category} />,
    group: STATUS_CATEGORY_LABELS[status.category],
    ...(index < 9 ? { shortcut: String(index + 1) } : {}),
  }));
  return (
    <SinglePicker
      {...base}
      field="Status"
      placeholder="Change status"
      options={options}
      value={value ?? NONE}
      onChange={onChange}
      icon={<StatusGlyph category={current?.category} />}
      text={current?.name ?? 'Status'}
      empty={current === undefined}
    />
  );
};

/** Props for PriorityPicker: the chosen priority. */
export interface PriorityPickerProps extends PickerBaseProps {
  value: IssuePriority;
  onChange: (priority: IssuePriority) => void;
}

/** Picks a priority, with 0 to 4 as keys from none through low. */
export const PriorityPicker: React.FC<PriorityPickerProps> = ({
  value,
  onChange,
  ...base
}) => {
  const variant = base.variant ?? 'rail';
  const options: ComboboxOption[] = PRIORITIES.map((priority, index) => ({
    value: priority,
    label: PRIORITY_LABELS[priority],
    icon: <PriorityGlyph priority={priority} />,
    shortcut: String(index),
  }));
  return (
    <SinglePicker
      {...base}
      field="Priority"
      placeholder="Set priority"
      options={options}
      value={value}
      onChange={(picked) => {
        onChange(picked as IssuePriority);
      }}
      icon={<PriorityGlyph priority={value} />}
      text={
        value === 'none'
          ? emptyText(variant, 'Priority', PRIORITY_LABELS.none)
          : PRIORITY_LABELS[value]
      }
      empty={value === 'none'}
    />
  );
};

/** Props for AssigneePicker: the people who may be assigned and the choice. */
export interface AssigneePickerProps extends PickerBaseProps {
  people: Assignable[];
  value: string | null;
  onChange: (userId: string | null) => void;
  /** Lists the signed in person first, marked as such. */
  currentUserId?: string;
}

/** Picks an assignee, with "No assignee" first and the caller next. */
export const AssigneePicker: React.FC<AssigneePickerProps> = ({
  people,
  value,
  onChange,
  currentUserId,
  ...base
}) => {
  const variant = base.variant ?? 'rail';
  const me = people.find((person) => person.user_id === currentUserId);
  const others = people.filter((person) => person.user_id !== currentUserId);
  const ordered = me === undefined ? others : [me, ...others];
  const current =
    value === null
      ? undefined
      : people.find((person) => person.user_id === value);
  const options: ComboboxOption[] = [
    {
      value: NONE,
      label: 'No assignee',
      icon: <LuUserRound className="h-3.5 w-3.5" />,
    },
    ...ordered.map((person) => ({
      value: person.user_id,
      label: personLabel(person),
      icon: <Avatar name={personLabel(person)} size="xs" />,
      keywords: [person.email],
      ...(person === me ? { detail: 'You' } : {}),
    })),
  ];
  return (
    <SinglePicker
      {...base}
      field="Assignee"
      placeholder="Assign to"
      options={options}
      value={value ?? NONE}
      onChange={(picked) => {
        onChange(picked === NONE ? null : picked);
      }}
      icon={
        value === null ? (
          <LuCircleDashed className="h-3.5 w-3.5" />
        ) : (
          <Avatar
            name={current === undefined ? '?' : personLabel(current)}
            size="xs"
          />
        )
      }
      text={
        value === null
          ? emptyText(variant, 'Assignee', 'No assignee')
          : personLabel(current)
      }
      empty={value === null}
    />
  );
};

/** A label's colour as a small dot. */
const LabelDot: React.FC<{ color: string }> = ({ color }) => (
  <span
    aria-hidden="true"
    className="h-2 w-2 shrink-0 rounded-full"
    style={{ backgroundColor: color }}
  />
);

/** Props for LabelsPicker: the team's labels and the chosen ones. */
export interface LabelsPickerProps extends PickerBaseProps {
  labels: LabelRead[];
  value: string[];
  onChange: (labelIds: string[]) => void;
  /**
   * Creates a label from the typed text, answering it or null on failure.
   * Leave unset for a caller who may not create labels, which hides the row.
   */
  onCreate?: (name: string) => Promise<LabelRead | null>;
}

/**
 * Picks any number of labels. The list stays open while toggling, so several
 * labels are one visit, and typed text that matches nothing can become a new
 * label when the caller may create one.
 */
export const LabelsPicker: React.FC<LabelsPickerProps> = ({
  labels,
  value,
  onChange,
  onCreate,
  disabled = false,
  variant = 'rail',
  align = 'start',
  className = '',
}) => {
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const chosen = labels.filter((label) => value.includes(label.id));
  const options: ComboboxOption[] = labels.map((label) => ({
    value: label.id,
    label: label.name,
    icon: <LabelDot color={label.color} />,
  }));

  const toggle = (labelId: string): void => {
    onChange(
      value.includes(labelId)
        ? value.filter((id) => id !== labelId)
        : [...value, labelId]
    );
  };

  const create = (name: string): void => {
    void onCreate?.(name).then((label) => {
      if (label !== null && !latest.current.includes(label.id)) {
        onChange([...latest.current, label.id]);
      }
    });
  };

  const emptyLabel = variant === 'chip' ? 'Labels' : 'Add label';
  const summary =
    chosen.length === 0
      ? emptyLabel
      : chosen.map((label) => label.name).join(', ');
  let text: React.ReactNode;
  let icon: React.ReactNode | undefined;
  if (chosen.length === 0) {
    icon = <LuTag className="h-3.5 w-3.5" />;
    text = emptyLabel;
  } else if (variant === 'rail') {
    text = (
      <span className="flex flex-wrap gap-1">
        {chosen.map((label) => (
          <span
            key={label.id}
            className="inline-flex h-5 items-center gap-1.5 rounded-full border border-line px-2 text-xs"
          >
            <LabelDot color={label.color} />
            {label.name}
          </span>
        ))}
      </span>
    );
  } else if (chosen.length === 1 && chosen[0] !== undefined) {
    icon = <LabelDot color={chosen[0].color} />;
    text = chosen[0].name;
  } else {
    icon = (
      <span className="flex -space-x-0.5">
        {chosen.slice(0, 3).map((label) => (
          <LabelDot key={label.id} color={label.color} />
        ))}
      </span>
    );
    text = `${String(chosen.length)} labels`;
  }

  return (
    <Popover
      label="Labels"
      align={align}
      block={variant === 'rail'}
      contentClassName="w-64"
      trigger={(trigger) => (
        <PickerButton
          trigger={trigger}
          field="Labels"
          icon={icon}
          text={text}
          spoken={summary}
          empty={chosen.length === 0}
          variant={variant}
          disabled={disabled}
          className={className}
        />
      )}
    >
      <Combobox
        label="Labels"
        placeholder={
          onCreate === undefined ? 'Change labels' : 'Change or create labels'
        }
        multiple
        options={options}
        selected={value}
        onSelect={toggle}
        {...(onCreate === undefined
          ? {}
          : {
              onCreate: create,
              createLabel: (typed: string) => `Create label "${typed}"`,
            })}
        emptyMessage="No labels"
      />
    </Popover>
  );
};

/** How an estimate reads: points on a numeric scale, the size otherwise. */
const estimateText = (value: string, scale: EstimateScale): string => {
  if (scale === 'tshirt') return value;
  return value === '1' ? '1 point' : `${value} points`;
};

/** Props for EstimatePicker: the team's scale and the chosen estimate. */
export interface EstimatePickerProps extends PickerBaseProps {
  scale: EstimateScale;
  value: string | null;
  onChange: (estimate: string | null) => void;
}

/** Picks an estimate from the team's scale. Draws nothing when it is off. */
export const EstimatePicker: React.FC<EstimatePickerProps> = ({
  scale,
  value,
  onChange,
  ...base
}) => {
  const choices = estimateChoices(scale);
  if (choices.length === 0) return null;
  const variant = base.variant ?? 'rail';
  const options: ComboboxOption[] = [
    { value: NONE, label: 'No estimate' },
    ...choices.map((choice) => ({
      value: choice,
      label: estimateText(choice, scale),
      icon: <LuTriangle className="h-3.5 w-3.5" />,
      keywords: [choice],
    })),
  ];
  return (
    <SinglePicker
      {...base}
      field="Estimate"
      placeholder="Set estimate"
      options={options}
      value={value ?? NONE}
      onChange={(picked) => {
        onChange(picked === NONE ? null : picked);
      }}
      icon={<LuTriangle className="h-3.5 w-3.5" />}
      text={
        value === null
          ? emptyText(variant, 'Estimate', 'No estimate')
          : estimateText(value, scale)
      }
      empty={value === null}
    />
  );
};

/** Props for ProjectPicker: the team's projects and the chosen one. */
export interface ProjectPickerProps extends PickerBaseProps {
  projects: ProjectRead[];
  value: string | null;
  onChange: (projectId: string | null) => void;
}

/** Picks the project an issue belongs to. */
export const ProjectPicker: React.FC<ProjectPickerProps> = ({
  projects,
  value,
  onChange,
  ...base
}) => {
  const variant = base.variant ?? 'rail';
  const current = projects.find((project) => project.project_id === value);
  const options: ComboboxOption[] = [
    { value: NONE, label: 'No project' },
    ...projects.map((project) => ({
      value: project.project_id,
      label: project.name,
      icon: <LuBox className="h-3.5 w-3.5" />,
      detail: PROJECT_STATUS_LABELS[project.status],
    })),
  ];
  return (
    <SinglePicker
      {...base}
      field="Project"
      placeholder="Move to project"
      options={options}
      value={value ?? NONE}
      onChange={(picked) => {
        onChange(picked === NONE ? null : picked);
      }}
      icon={<LuBox className="h-3.5 w-3.5" />}
      text={
        value === null
          ? emptyText(variant, 'Project', 'No project')
          : (current?.name ?? 'Project')
      }
      empty={value === null}
    />
  );
};

/** Props for CyclePicker: the team's cycles and the chosen one. */
export interface CyclePickerProps extends PickerBaseProps {
  cycles: CycleRead[];
  value: string | null;
  onChange: (cycleId: string | null) => void;
}

/**
 * Picks the cycle an issue is planned into. Finished and cancelled cycles are
 * left out, since nobody plans into the past, unless the issue is already in
 * one, so the current value is always in the list.
 */
export const CyclePicker: React.FC<CyclePickerProps> = ({
  cycles,
  value,
  onChange,
  ...base
}) => {
  const variant = base.variant ?? 'rail';
  const current = cycles.find((cycle) => cycle.cycle_id === value);
  const open = cycles.filter(
    (cycle) =>
      cycle.cycle_id === value ||
      (cycle.status !== 'completed' && cycle.status !== 'cancelled')
  );
  const options: ComboboxOption[] = [
    { value: NONE, label: 'No cycle' },
    ...open.map((cycle) => ({
      value: cycle.cycle_id,
      label: cycle.name,
      icon: <LuIterationCw className="h-3.5 w-3.5" />,
      detail: CYCLE_STATUS_LABELS[cycle.status],
    })),
  ];
  return (
    <SinglePicker
      {...base}
      field="Cycle"
      placeholder="Move to cycle"
      options={options}
      value={value ?? NONE}
      onChange={(picked) => {
        onChange(picked === NONE ? null : picked);
      }}
      icon={<LuIterationCw className="h-3.5 w-3.5" />}
      text={
        value === null
          ? emptyText(variant, 'Cycle', 'No cycle')
          : (current?.name ?? 'Cycle')
      }
      empty={value === null}
    />
  );
};

/** Props for the custom date field at the foot of a date picker. */
interface CustomDateProps {
  value: string | null;
  min?: string;
  max?: string;
  onPick: (value: string) => void;
}

/**
 * A native date field for a day the presets do not cover. It commits only a
 * complete date inside the allowed range, and says why when it refuses.
 */
const CustomDate: React.FC<CustomDateProps> = ({ value, min, max, onPick }) => {
  const [draft, setDraft] = useState(value ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className="space-y-1.5">
      <input
        type="date"
        aria-label="Custom date"
        value={draft}
        min={min}
        max={max}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.preventDefault();
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (!DATE_PATTERN.test(next)) {
            setProblem(null);
            return;
          }
          const refusal =
            validateDateRange(min ?? '', next) ??
            validateDateRange(next, max ?? '');
          setProblem(refusal);
          if (refusal === null) onPick(next);
        }}
        className="h-7 w-full rounded-sm border border-line bg-transparent px-2 text-xs text-text"
      />
      {problem !== null && (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      )}
    </div>
  );
};

/** Props for DatePicker: which date, its value and the range it must keep. */
export interface DatePickerProps extends PickerBaseProps {
  /** The field's name, such as "Due date". */
  field: string;
  value: string | null;
  onChange: (value: string | null) => void;
  /** The earliest day allowed, such as the start date for a due date. */
  min?: string;
  /** The latest day allowed, such as the due date for a start date. */
  max?: string;
  icon?: React.ReactNode;
}

/**
 * Picks a day from quick presets or a custom field. Presets that fall outside
 * the allowed range are shown but disabled, so the refusal is visible.
 */
export const DatePicker: React.FC<DatePickerProps> = ({
  field,
  value,
  onChange,
  min,
  max,
  icon = <LuCalendar className="h-3.5 w-3.5" />,
  ...base
}) => {
  const variant = base.variant ?? 'rail';
  const [today] = useState(() => new Date());
  const options: ComboboxOption[] = datePresets(today).map((preset) => ({
    value: preset.value,
    label: preset.label,
    detail: shortDateLabel(preset.value, today),
    disabled: !dateInRange(preset.value, min, max),
  }));
  if (value !== null) {
    options.push({
      value: NONE,
      label: 'Clear date',
      icon: <LuX className="h-3.5 w-3.5" />,
    });
  }
  return (
    <SinglePicker
      {...base}
      field={field}
      placeholder="Pick a day"
      options={options}
      value={value ?? NONE}
      onChange={(picked) => {
        onChange(picked === NONE ? null : picked);
      }}
      icon={icon}
      text={
        value === null
          ? emptyText(variant, field, `No ${field.toLowerCase()}`)
          : shortDateLabel(value, today)
      }
      empty={value === null}
      footer={(close) => (
        <CustomDate
          value={value}
          {...(min === undefined || min === '' ? {} : { min })}
          {...(max === undefined || max === '' ? {} : { max })}
          onPick={(picked) => {
            close();
            if (picked !== value) onChange(picked);
          }}
        />
      )}
    />
  );
};

/** Props for ParentPicker: the candidate parents and the chosen one. */
export interface ParentPickerProps extends PickerBaseProps {
  /** Issues this one may sit under, already narrowed to the same team. */
  candidates: IssueRead[];
  value: string | null;
  onChange: (parentId: string | null) => void;
}

/** Picks the parent issue, matched by key or title. */
export const ParentPicker: React.FC<ParentPickerProps> = ({
  candidates,
  value,
  onChange,
  ...base
}) => {
  const variant = base.variant ?? 'rail';
  const current = candidates.find((candidate) => candidate.id === value);
  const options: ComboboxOption[] = [
    { value: NONE, label: 'No parent' },
    ...candidates.map((candidate) => ({
      value: candidate.id,
      label: candidate.title,
      detail: candidate.key,
      keywords: [candidate.key],
    })),
  ];
  return (
    <SinglePicker
      {...base}
      field="Parent"
      placeholder="Set parent issue"
      options={options}
      value={value ?? NONE}
      onChange={(picked) => {
        onChange(picked === NONE ? null : picked);
      }}
      icon={<LuCornerUpLeft className="h-3.5 w-3.5" />}
      text={
        value === null
          ? emptyText(variant, 'Parent', 'No parent')
          : current === undefined
            ? 'Parent issue'
            : `${current.key} ${current.title}`
      }
      empty={value === null}
    />
  );
};
