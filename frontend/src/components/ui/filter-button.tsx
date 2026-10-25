/**
 * A list toolbar's filter chip: dashed while nothing is chosen, filled with
 * the choice once one is, opening that filter's options in a searchable list.
 * The projects and initiatives lists draw their filters with it so every
 * planning list filters the same way.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import { Combobox, type ComboboxOption } from './combobox';
import { Popover } from './popover';

/** Props for FilterButton: one filter's options and what is chosen. */
export interface FilterButtonProps {
  field: string;
  options: ComboboxOption[];
  selected: string[];
  multiple?: boolean;
  onSelect: (value: string) => void;
}

/** A toolbar chip that opens one filter's options. */
export const FilterButton: React.FC<FilterButtonProps> = ({
  field,
  options,
  selected,
  multiple = false,
  onSelect,
}) => {
  const chosen = options.filter((option) => selected.includes(option.value));
  const summary =
    chosen.length === 0
      ? null
      : chosen.length === 1
        ? (chosen[0]?.label ?? '')
        : `${String(chosen.length)} selected`;
  return (
    <Popover
      label={field}
      contentClassName="w-60"
      trigger={(trigger) => (
        <button
          type="button"
          {...trigger}
          aria-label={`${field} filter${summary === null ? '' : `: ${summary}`}`}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors duration-100',
            summary === null
              ? 'border-dashed border-line text-text-muted hover:border-line-strong hover:text-text'
              : 'border-line bg-raised text-text hover:border-line-strong'
          )}
        >
          <span className={summary === null ? '' : 'text-text-muted'}>
            {field}
          </span>
          {summary !== null && <span className="font-medium">{summary}</span>}
        </button>
      )}
    >
      {(close) => (
        <Combobox
          label={field}
          placeholder={`Filter by ${field.toLowerCase()}`}
          options={options}
          selected={selected}
          multiple={multiple}
          onSelect={(value) => {
            onSelect(value);
            if (!multiple) close();
          }}
        />
      )}
    </Popover>
  );
};

export default FilterButton;
