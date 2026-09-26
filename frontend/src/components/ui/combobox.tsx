/**
 * A searchable command list: a filter input over a list of options, driven
 * from the keyboard the way a picker in a fast issue tracker is. Typing
 * filters, the arrows move, Enter picks, and a single character shortcut shown
 * on the right picks directly while the filter is empty. In multiple mode each
 * option carries a checkbox and Enter toggles without closing, which is what
 * picking several labels in a row wants.
 *
 * It renders no floating chrome of its own, so it sits inside a Popover for a
 * property picker and could equally sit inside a command palette.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { LuCheck, LuPlus } from 'react-icons/lu';
import { cn } from '../../lib/cn';

/** One choice in the list. */
export interface ComboboxOption {
  /** The value handed back on selection. Unique within the list. */
  value: string;
  /** The text shown and matched against the filter. */
  label: string;
  /** A glyph drawn before the label. */
  icon?: React.ReactNode;
  /** Quieter text drawn after the label, also matched by the filter. */
  detail?: string;
  /** The heading this option sits under. Groups keep first seen order. */
  group?: string;
  /** Extra words the filter matches, such as an email behind a name. */
  keywords?: string[];
  /** A single key that picks this option while the filter is empty. */
  shortcut?: string;
  disabled?: boolean;
}

/** Props for Combobox: the options, what is selected and what picking does. */
export interface ComboboxProps {
  /** The name announced for the filter input and the list. */
  label: string;
  options: ComboboxOption[];
  /** The values currently chosen, drawn with a check. */
  selected: string[];
  /** Lets several values be chosen, toggling rather than replacing. */
  multiple?: boolean;
  /** Called with the picked value. */
  onSelect: (value: string) => void;
  /** Offers a create row for text that matches no option. */
  onCreate?: (text: string) => void;
  /** How the create row reads for the typed text. */
  createLabel?: (text: string) => string;
  placeholder?: string;
  /** Shown when the filter matches nothing and nothing can be created. */
  emptyMessage?: string;
  /** Content drawn under the list, such as a custom date field. */
  footer?: React.ReactNode;
  className?: string;
}

/** The value the create row carries, outside any real option's range. */
const CREATE_VALUE = '\u0000create';

/** Whether an option matches the filter text, ignoring case. */
const matches = (option: ComboboxOption, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    option.label,
    option.detail ?? '',
    option.group ?? '',
    ...(option.keywords ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
};

/** The filter input and the keyboard driven list under it. */
export const Combobox: React.FC<ComboboxProps> = ({
  label,
  options,
  selected,
  multiple = false,
  onSelect,
  onCreate,
  createLabel = (text) => `Create "${text}"`,
  placeholder = 'Search',
  emptyMessage = 'No results',
  footer,
  className = '',
}) => {
  const [query, setQuery] = useState('');
  const listId = useId();
  const optionIdPrefix = useId();
  const list = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => options.filter((option) => matches(option, query)),
    [options, query]
  );

  const trimmed = query.trim();
  const canCreate =
    onCreate !== undefined &&
    trimmed !== '' &&
    !options.some(
      (option) => option.label.toLowerCase() === trimmed.toLowerCase()
    );

  const rows: ComboboxOption[] = canCreate
    ? [
        ...filtered,
        {
          value: CREATE_VALUE,
          label: createLabel(trimmed),
          icon: <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />,
        },
      ]
    : filtered;

  const firstSelected = rows.findIndex((row) => selected.includes(row.value));
  const [active, setActive] = useState(() =>
    firstSelected >= 0 ? firstSelected : 0
  );
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0));
  const activeRow = rows[activeIndex];

  useEffect(() => {
    if (activeRow === undefined) return;
    const node = list.current?.querySelector<HTMLElement>(
      `[data-index="${String(activeIndex)}"]`
    );
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, activeRow]);

  const pick = (row: ComboboxOption | undefined): void => {
    if (row === undefined || row.disabled === true) return;
    if (row.value === CREATE_VALUE) {
      onCreate?.(trimmed);
      setQuery('');
      return;
    }
    onSelect(row.value);
  };

  const move = (step: number): void => {
    if (rows.length === 0) return;
    let next = activeIndex;
    for (let tries = 0; tries < rows.length; tries += 1) {
      next = (next + step + rows.length) % rows.length;
      if (rows[next]?.disabled !== true) break;
    }
    setActive(next);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        setActive(0);
        return;
      case 'End':
        event.preventDefault();
        setActive(Math.max(rows.length - 1, 0));
        return;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        pick(activeRow);
        return;
      default:
        break;
    }
    if (
      query === '' &&
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      const hit = options.find(
        (option) => option.shortcut === event.key && option.disabled !== true
      );
      if (hit !== undefined) {
        event.preventDefault();
        onSelect(hit.value);
      }
    }
  };

  const groups: { name: string | undefined; rows: number[] }[] = [];
  rows.forEach((row, index) => {
    const name = row.value === CREATE_VALUE ? undefined : row.group;
    const held = groups.find((group) => group.name === name);
    if (held === undefined) groups.push({ name, rows: [index] });
    else held.rows.push(index);
  });

  const optionId = (index: number): string =>
    `${optionIdPrefix}-${String(index)}`;

  return (
    <div className={cn('flex flex-col', className)}>
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          activeRow === undefined ? undefined : optionId(activeIndex)
        }
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="h-9 w-full rounded-t-md border-0 border-b border-line bg-transparent px-3 text-sm text-text outline-none placeholder:text-text-faint focus-visible:outline-none"
      />
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple ? 'true' : undefined}
        className="scrollbar-thin max-h-72 overflow-y-auto p-1"
      >
        {rows.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-text-faint">{emptyMessage}</p>
        )}
        {groups.map((group) => {
          const headingId =
            group.name === undefined ? undefined : `${listId}-${group.name}`;
          return (
            <div
              key={group.name ?? '\u0000'}
              role={group.name === undefined ? undefined : 'group'}
              aria-labelledby={headingId}
            >
              {group.name !== undefined && (
                <div
                  id={headingId}
                  className="px-2 pt-1.5 pb-1 text-2xs font-medium text-text-faint"
                >
                  {group.name}
                </div>
              )}
              {group.rows.map((index) => {
                const row = rows[index];
                if (row === undefined) return null;
                const isSelected = selected.includes(row.value);
                const isActive = index === activeIndex;
                return (
                  <div
                    key={row.value}
                    id={optionId(index)}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={row.disabled === true ? 'true' : undefined}
                    data-active={isActive ? 'true' : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onMouseMove={() => {
                      if (!isActive) setActive(index);
                    }}
                    onClick={() => {
                      setActive(index);
                      pick(row);
                    }}
                    className={cn(
                      'flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text select-none',
                      isActive && 'bg-raised',
                      row.disabled === true && 'opacity-50'
                    )}
                  >
                    {multiple && row.value !== CREATE_VALUE && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-xs border',
                          isSelected
                            ? 'border-accent bg-accent text-on-accent'
                            : 'border-line-strong'
                        )}
                      >
                        {isSelected && <LuCheck className="h-2.5 w-2.5" />}
                      </span>
                    )}
                    {row.icon !== undefined && (
                      <span
                        aria-hidden="true"
                        className="flex w-4 shrink-0 items-center justify-center text-text-muted"
                      >
                        {row.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {row.label}
                      {row.detail !== undefined && (
                        <span className="ml-1.5 text-text-faint">
                          {row.detail}
                        </span>
                      )}
                    </span>
                    {!multiple && isSelected && (
                      <LuCheck
                        aria-hidden="true"
                        className="h-3.5 w-3.5 shrink-0 text-text-muted"
                      />
                    )}
                    {row.shortcut !== undefined && (
                      <kbd className="shrink-0 font-sans text-2xs text-text-faint">
                        {row.shortcut}
                      </kbd>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {footer !== undefined && (
        <div className="border-t border-line p-2">{footer}</div>
      )}
    </div>
  );
};

export default Combobox;
