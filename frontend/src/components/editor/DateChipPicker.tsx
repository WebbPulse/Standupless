/**
 * The popover the `/date` command opens at the caret: a field that reads a
 * typed day, the Today, Tomorrow and Next week quick picks, and a month
 * calendar laid out from the viewer's week start. Picking a day hands its ISO
 * form back so the editor can insert a date chip there.
 */

import React, { useMemo, useState } from 'react';
import { LuChevronLeft, LuChevronRight } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { monthGrid, weekdayNames } from '../../lib/dateChips';
import { parseTypedDate } from '../../lib/parseDate';
import { weekStartDay } from '../../lib/preferences';
import {
  datePresets,
  isoDate,
  longDateLabel,
  shortDateLabel,
} from '../../lib/propertyOptions';

/** The quick picks the popover lists, in order. */
const PRESETS = new Set(['Today', 'Tomorrow', 'Next week']);

/** One row of the popover's list. */
interface PickerRow {
  value: string;
  label: string;
  detail: string;
}

/** Props for DateChipPicker: where it opens and what a pick or close does. */
export interface DateChipPickerProps {
  top: number;
  left: number;
  onPick: (value: string) => void;
  onClose: () => void;
  /** Called when focus leaves for somewhere outside the editor surface. */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
  today?: Date;
}

/** The date chip picker. */
export const DateChipPicker: React.FC<DateChipPickerProps> = ({
  top,
  left,
  onPick,
  onClose,
  onBlur,
  today: givenToday,
}) => {
  const [today] = useState(() => givenToday ?? new Date());
  const weekStart = weekStartDay();
  const todayValue = isoDate(today);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [month, setMonth] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1)
  );

  const rows = useMemo<PickerRow[]>(() => {
    const presets = datePresets(today, weekStart)
      .filter((preset) => PRESETS.has(preset.label))
      .map((preset) => ({
        value: preset.value,
        label: preset.label,
        detail: shortDateLabel(preset.value, today),
      }));
    if (query.trim() === '') return presets;
    const typed = parseTypedDate(query, today, { weekStart });
    if (typed === null) return [];
    const value = isoDate(typed);
    return [{ value, label: longDateLabel(value, today), detail: '' }];
  }, [query, today, weekStart]);
  const shown = Math.min(highlight, Math.max(0, rows.length - 1));
  const days = monthGrid(month, weekStart);

  const keep = (event: React.MouseEvent): void => {
    event.preventDefault();
  };

  return (
    <div
      role="dialog"
      aria-label="Pick a date"
      className="absolute z-20 w-64 rounded-md border border-line bg-overlay p-1 shadow-overlay"
      style={{ top, left }}
    >
      <input
        autoFocus
        type="text"
        aria-label="Date"
        placeholder="Try fri, in 3 days or nov 12"
        value={query}
        className="h-7 w-full rounded-sm bg-transparent px-2 text-sm text-text outline-none placeholder:text-text-faint"
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          const count = rows.length;
          if (
            count > 0 &&
            (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ) {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setHighlight((shown + step + count) % count);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            const row = rows[shown];
            if (row !== undefined) onPick(row.value);
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onBlur={onBlur}
      />
      <ul role="listbox" aria-label="Dates" className="py-1">
        {rows.map((row, index) => (
          <li
            key={`${row.label}-${row.value}`}
            role="option"
            aria-selected={index === shown}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-raised hover:text-text',
              index === shown ? 'bg-raised text-text' : 'text-text-muted'
            )}
            onMouseDown={keep}
            onClick={() => {
              onPick(row.value);
            }}
            onMouseEnter={() => {
              setHighlight(index);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.detail !== '' && (
              <span className="shrink-0 text-xs text-text-faint">
                {row.detail}
              </span>
            )}
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-text-faint">
            Not a date yet
          </li>
        )}
      </ul>
      <div className="border-t border-line px-1 pt-2 pb-1">
        <div className="mb-1 flex items-center justify-between">
          <span className="px-1 text-xs font-medium text-text">
            {month.toLocaleDateString(undefined, {
              month: 'long',
              year: 'numeric',
            })}
          </span>
          <span className="flex gap-0.5">
            <button
              type="button"
              aria-label="Previous month"
              className="rounded-sm p-1 text-text-muted hover:bg-raised hover:text-text"
              onMouseDown={keep}
              onClick={() => {
                setMonth(
                  new Date(month.getFullYear(), month.getMonth() - 1, 1)
                );
              }}
            >
              <LuChevronLeft aria-hidden className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label="Next month"
              className="rounded-sm p-1 text-text-muted hover:bg-raised hover:text-text"
              onMouseDown={keep}
              onClick={() => {
                setMonth(
                  new Date(month.getFullYear(), month.getMonth() + 1, 1)
                );
              }}
            >
              <LuChevronRight aria-hidden className="size-3.5" />
            </button>
          </span>
        </div>
        <div className="grid grid-cols-7 text-center text-xs">
          {weekdayNames(weekStart).map((weekday) => (
            <span
              key={weekday.day}
              aria-hidden
              className="py-1 text-text-faint"
            >
              {weekday.name}
            </span>
          ))}
          {days.map((day) => {
            const value = isoDate(day);
            const inMonth = day.getMonth() === month.getMonth();
            return (
              <button
                key={value}
                type="button"
                aria-label={longDateLabel(value, today)}
                className={cn(
                  'm-px rounded-sm py-1 hover:bg-raised hover:text-text',
                  inMonth ? 'text-text' : 'text-text-faint',
                  value === todayValue && 'ring-1 ring-focus'
                )}
                onMouseDown={keep}
                onClick={() => {
                  onPick(value);
                }}
              >
                {day.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default DateChipPicker;
