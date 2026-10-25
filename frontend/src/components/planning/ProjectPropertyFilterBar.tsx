/**
 * The projects page's Linear style filter menu for health, priority, members,
 * start and target dates, and last update age. A Filter button lists the
 * fields and opens one field's values; every set filter then shows as a chip
 * reading field, verb and value, whose value reopens the picker and whose X
 * removes that filter alone. Date presets store an offset relative to today,
 * as the issue filter bar's do, so a saved view keeps rolling; a custom date
 * stores the day it names.
 */

import React, { useState } from 'react';
import {
  LuCalendar,
  LuCalendarClock,
  LuChevronLeft,
  LuActivity,
  LuListFilter,
  LuMessageSquareText,
  LuSignal,
  LuUsers,
  LuX,
} from 'react-icons/lu';
import { cn } from '../../lib/cn';
import {
  dayBoundChip,
  dayLabel,
  resolveDayBound,
  type DayPreset,
} from '../../lib/filterDays';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { PROJECT_HEALTHS, PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import {
  NO_VALUE,
  type ProjectPropertyFilters,
  type PropertyListKey,
  type PropertyScalarKey,
} from '../../lib/projectPropertyFilters';
import type { IssuePriority } from '../../types/Api';
import Avatar from '../ui/avatar';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import { PriorityGlyph } from '../ui/glyphs';
import { Input } from '../ui/input';
import { Popover } from '../ui/popover';
import ProjectHealthGlyph from './ProjectHealthGlyph';

/** One field the menu offers. */
type Field = 'health' | 'priority' | 'member' | 'start' | 'target' | 'update';

const FIELD_LABELS: Record<Field, string> = {
  health: 'Health',
  priority: 'Priority',
  member: 'Members',
  start: 'Start date',
  target: 'Target date',
  update: 'Last update',
};

const FIELD_ICONS: Record<Field, React.ReactNode> = {
  health: <LuActivity className="h-3.5 w-3.5 text-text-muted" />,
  priority: <LuSignal className="h-3.5 w-3.5 text-text-muted" />,
  member: <LuUsers className="h-3.5 w-3.5 text-text-muted" />,
  start: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
  target: <LuCalendarClock className="h-3.5 w-3.5 text-text-muted" />,
  update: <LuMessageSquareText className="h-3.5 w-3.5 text-text-muted" />,
};

const FIELDS: readonly Field[] = [
  'health',
  'priority',
  'member',
  'start',
  'target',
  'update',
];

/** The project priorities, worst first and unset last. */
const PRIORITY_ROWS: readonly IssuePriority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];

/** The relative bounds a start or target bound offers, ahead and behind, each stored as its offset. */
const DATE_PRESETS: readonly DayPreset[] = [
  { label: 'Today', value: 'today' },
  { label: 'In 1 week', value: '+1w' },
  { label: 'In 2 weeks', value: '+2w' },
  { label: 'In 1 month', value: '+1m' },
  { label: 'In 3 months', value: '+3m' },
  { label: '1 week ago', value: '-1w' },
  { label: '1 month ago', value: '-1m' },
  { label: '3 months ago', value: '-3m' },
];

/** The update age windows offered, in days. */
const AGE_PRESETS: readonly { days: string; label: string }[] = [
  { days: '1', label: 'day' },
  { days: '7', label: 'week' },
  { days: '14', label: '2 weeks' },
  { days: '30', label: 'month' },
  { days: '90', label: '3 months' },
];

/** How a number of days reads on a chip. */
const daysText = (days: string): string =>
  days === '1' ? '1 day' : `${days} days`;

/** The date bound keys of one date field, by verb. */
const BOUND_KEYS: Record<
  'start' | 'target',
  Record<'before' | 'after', PropertyScalarKey>
> = {
  start: { before: 'startBefore', after: 'startAfter' },
  target: { before: 'targetBefore', after: 'targetAfter' },
};

/** Props for ProjectPropertyFilterBar: the filters, the people to offer, and how to change them. */
export interface ProjectPropertyFilterBarProps {
  filters: ProjectPropertyFilters;
  people: readonly Assignable[];
  onChange: (filters: ProjectPropertyFilters) => void;
}

/** The value options a list field offers. */
const listOptions = (
  field: PropertyListKey,
  people: readonly Assignable[]
): ComboboxOption[] => {
  if (field === 'health') {
    return [
      ...PROJECT_HEALTHS.map((health) => ({
        value: health,
        label: PROJECT_HEALTH_LABELS[health],
        icon: <ProjectHealthGlyph health={health} />,
      })),
      {
        value: NO_VALUE,
        label: 'No health',
        icon: <ProjectHealthGlyph health={null} />,
      },
    ];
  }
  if (field === 'priority') {
    return PRIORITY_ROWS.map((priority) => ({
      value: priority,
      label: PRIORITY_LABELS[priority],
      icon: <PriorityGlyph priority={priority} />,
    }));
  }
  return [
    { value: NO_VALUE, label: 'No members' },
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
};

/** A list field's values, toggled one at a time. */
const ListPicker: React.FC<{
  field: PropertyListKey;
  filters: ProjectPropertyFilters;
  people: readonly Assignable[];
  onChange: (filters: ProjectPropertyFilters) => void;
}> = ({ field, filters, people, onChange }) => {
  const label = FIELD_LABELS[field];
  return (
    <Combobox
      label={label}
      placeholder={`Filter by ${label.toLowerCase()}`}
      options={listOptions(field, people)}
      selected={filters[field]}
      multiple
      onSelect={(value) => {
        const held = filters[field];
        onChange({
          ...filters,
          [field]: held.includes(value)
            ? held.filter((item) => item !== value)
            : [...held, value],
        });
      }}
    />
  );
};

/** A start or target bound: before or after, a preset day or any other. */
const DatePicker: React.FC<{
  field: 'start' | 'target';
  initialOp: 'before' | 'after';
  filters: ProjectPropertyFilters;
  onChange: (filters: ProjectPropertyFilters) => void;
  onDone: () => void;
}> = ({ field, initialOp, filters, onChange, onDone }) => {
  const [op, setOp] = useState<'before' | 'after'>(initialOp);
  const key = BOUND_KEYS[field][op];
  const held = filters[key];
  const name = `${FIELD_LABELS[field]} ${op}`;
  const set = (day: string): void => {
    onChange({ ...filters, [key]: day });
  };
  return (
    <div>
      <div
        role="group"
        aria-label={`${FIELD_LABELS[field]} bound`}
        className="flex gap-1 border-b border-line p-1.5"
      >
        {(['before', 'after'] as const).map((verb) => (
          <button
            key={verb}
            type="button"
            aria-pressed={op === verb}
            onClick={() => {
              setOp(verb);
            }}
            className={cn(
              'flex-1 rounded-sm px-2 py-1 text-xs capitalize',
              op === verb
                ? 'bg-raised text-text'
                : 'text-text-muted hover:text-text'
            )}
          >
            {verb}
          </button>
        ))}
      </div>
      <Combobox
        label={name}
        placeholder={`${name}...`}
        options={DATE_PRESETS.map((preset) => ({
          value: preset.value,
          label: preset.label,
          icon: <LuCalendar className="h-3.5 w-3.5 text-text-muted" />,
          detail: dayLabel(resolveDayBound(preset.value)),
        }))}
        selected={DATE_PRESETS.filter((preset) => preset.value === held).map(
          (preset) => preset.value
        )}
        onSelect={(value) => {
          set(value);
          onDone();
        }}
        footer={
          <label className="flex items-center gap-2 border-t border-line px-2 py-2 text-xs text-text-muted">
            Custom date
            <Input
              type="date"
              aria-label={`${name} date`}
              className="flex-1"
              value={held === '' ? '' : resolveDayBound(held)}
              onChange={(event) => {
                if (event.target.value !== '') set(event.target.value);
              }}
            />
          </label>
        }
      />
    </div>
  );
};

/** The last update windows: updated within, or not updated within, a number of days. */
const UpdatePicker: React.FC<{
  filters: ProjectPropertyFilters;
  onChange: (filters: ProjectPropertyFilters) => void;
  onDone: () => void;
}> = ({ filters, onChange, onDone }) => (
  <Combobox
    label="Last update"
    placeholder="Last update..."
    options={[
      ...AGE_PRESETS.map((preset) => ({
        value: `within:${preset.days}`,
        label: `Updated in the last ${preset.label}`,
        group: 'Updated',
      })),
      ...AGE_PRESETS.slice(1).map((preset) => ({
        value: `stale:${preset.days}`,
        label: `No update in the last ${preset.label}`,
        group: 'Not updated',
      })),
    ]}
    selected={[
      ...(filters.updatedWithin === ''
        ? []
        : [`within:${filters.updatedWithin}`]),
      ...(filters.notUpdatedWithin === ''
        ? []
        : [`stale:${filters.notUpdatedWithin}`]),
    ]}
    onSelect={(value) => {
      const [kind, days = ''] = value.split(':');
      onChange(
        kind === 'within'
          ? {
              ...filters,
              updatedWithin: filters.updatedWithin === days ? '' : days,
            }
          : {
              ...filters,
              notUpdatedWithin: filters.notUpdatedWithin === days ? '' : days,
            }
      );
      onDone();
    }}
  />
);

/** One field's picker, as the menu and a chip open it. */
const FieldPicker: React.FC<{
  field: Field;
  op?: 'before' | 'after';
  filters: ProjectPropertyFilters;
  people: readonly Assignable[];
  onChange: (filters: ProjectPropertyFilters) => void;
  onDone: () => void;
}> = ({ field, op, filters, people, onChange, onDone }) =>
  field === 'start' || field === 'target' ? (
    <DatePicker
      field={field}
      initialOp={op ?? 'before'}
      filters={filters}
      onChange={onChange}
      onDone={onDone}
    />
  ) : field === 'update' ? (
    <UpdatePicker filters={filters} onChange={onChange} onDone={onDone} />
  ) : (
    <ListPicker
      field={field}
      filters={filters}
      people={people}
      onChange={onChange}
    />
  );

/** One set filter as a chip: field, verb, a value that reopens the picker, and its remove button. */
interface Chip {
  id: string;
  field: Field;
  verb: string;
  summary: string;
  op?: 'before' | 'after';
  clear: (filters: ProjectPropertyFilters) => ProjectPropertyFilters;
}

/** How a list filter's values read on its chip. */
const listSummary = (
  field: PropertyListKey,
  values: readonly string[],
  people: readonly Assignable[]
): string => {
  const options = listOptions(field, people);
  const names = values.map(
    (value) =>
      options.find((option) => option.value === value)?.label ?? '1 person'
  );
  return names.length <= 2
    ? names.join(', ')
    : `${String(names.length)} ${FIELD_LABELS[field].toLowerCase()}`;
};

/** Every set filter as a chip, in the menu's order. */
const chipsOf = (
  filters: ProjectPropertyFilters,
  people: readonly Assignable[]
): Chip[] => {
  const chips: Chip[] = [];
  for (const field of ['health', 'priority', 'member'] as const) {
    const values = filters[field];
    if (values.length === 0) continue;
    chips.push({
      id: field,
      field,
      verb:
        field === 'member'
          ? values.length > 1
            ? 'include any of'
            : 'include'
          : values.length > 1
            ? 'is any of'
            : 'is',
      summary: listSummary(field, values, people),
      clear: (held) => ({ ...held, [field]: [] }),
    });
  }
  for (const field of ['start', 'target'] as const) {
    for (const op of ['after', 'before'] as const) {
      const key = BOUND_KEYS[field][op];
      const day = filters[key];
      if (day === '') continue;
      const { verb, summary } = dayBoundChip(op, day);
      chips.push({
        id: key,
        field,
        verb,
        op,
        summary,
        clear: (held) => ({ ...held, [key]: '' }),
      });
    }
  }
  if (filters.updatedWithin !== '') {
    chips.push({
      id: 'updatedWithin',
      field: 'update',
      verb: 'within',
      summary: daysText(filters.updatedWithin),
      clear: (held) => ({ ...held, updatedWithin: '' }),
    });
  }
  if (filters.notUpdatedWithin !== '') {
    chips.push({
      id: 'notUpdatedWithin',
      field: 'update',
      verb: 'older than',
      summary: daysText(filters.notUpdatedWithin),
      clear: (held) => ({ ...held, notUpdatedWithin: '' }),
    });
  }
  return chips;
};

const SEGMENT =
  'flex h-full items-center px-2 hover:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

/** One set filter's chip. */
const FilterChip: React.FC<{
  chip: Chip;
  filters: ProjectPropertyFilters;
  people: readonly Assignable[];
  onChange: (filters: ProjectPropertyFilters) => void;
}> = ({ chip, filters, people, onChange }) => {
  const [open, setOpen] = useState(false);
  const name = `${FIELD_LABELS[chip.field]} ${chip.verb}`;
  return (
    <span
      role="group"
      aria-label={`${name} ${chip.summary}`}
      className="flex h-7 items-center overflow-hidden rounded-md border border-line text-xs"
    >
      <span className="flex h-full items-center gap-1.5 border-r border-line px-2 text-text-muted">
        {FIELD_ICONS[chip.field]}
        {FIELD_LABELS[chip.field]}
      </span>
      <span className="flex h-full items-center border-r border-line px-2 text-text-muted">
        {chip.verb}
      </span>
      <Popover
        label={`${name} values`}
        contentClassName="w-72 p-0"
        className="h-full"
        open={open}
        onOpenChange={setOpen}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className={cn(SEGMENT, 'max-w-56 border-r border-line text-text')}
          >
            <span className="truncate">{chip.summary}</span>
          </button>
        )}
      >
        <FieldPicker
          field={chip.field}
          {...(chip.op === undefined ? {} : { op: chip.op })}
          filters={filters}
          people={people}
          onChange={onChange}
          onDone={() => {
            setOpen(false);
          }}
        />
      </Popover>
      <button
        type="button"
        aria-label={`Remove ${chip.op === undefined && chip.field !== 'update' ? FIELD_LABELS[chip.field] : name} filter`}
        onClick={() => {
          onChange(chip.clear(filters));
        }}
        className={cn(SEGMENT, 'px-1.5 text-text-faint hover:text-text')}
      >
        <LuX className="h-3 w-3" />
      </button>
    </span>
  );
};

/** The Filter menu and a chip for every property filter set. */
export const ProjectPropertyFilterBar: React.FC<
  ProjectPropertyFilterBarProps
> = ({ filters, people, onChange }) => {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<Field | null>(null);
  const close = (): void => {
    setOpen(false);
    setField(null);
  };
  return (
    <>
      {chipsOf(filters, people).map((chip) => (
        <FilterChip
          key={chip.id}
          chip={chip}
          filters={filters}
          people={people}
          onChange={onChange}
        />
      ))}
      <Popover
        label={field === null ? 'Filter' : FIELD_LABELS[field]}
        contentClassName="w-72 p-0"
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else close();
        }}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-dashed border-line px-2 text-xs text-text-muted transition-colors duration-100 hover:border-line-strong hover:text-text"
          >
            <LuListFilter aria-hidden="true" className="h-3.5 w-3.5" />
            Filter
          </button>
        )}
      >
        {field === null ? (
          <Combobox
            label="Filter by"
            placeholder="Filter by..."
            options={FIELDS.map((value) => ({
              value,
              label: FIELD_LABELS[value],
              icon: FIELD_ICONS[value],
            }))}
            selected={[]}
            onSelect={(value) => {
              setField(value as Field);
            }}
          />
        ) : (
          <div>
            <button
              type="button"
              onClick={() => {
                setField(null);
              }}
              className="flex w-full items-center gap-1.5 border-b border-line px-2 py-1.5 text-xs text-text-muted hover:text-text"
            >
              <LuChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
              {FIELD_LABELS[field]}
            </button>
            <FieldPicker
              field={field}
              filters={filters}
              people={people}
              onChange={onChange}
              onDone={close}
            />
          </div>
        )}
      </Popover>
    </>
  );
};

export default ProjectPropertyFilterBar;
