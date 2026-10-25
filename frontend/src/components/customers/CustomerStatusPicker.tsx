/**
 * The customer status picker: a chip naming the status with its dot, opening a
 * menu of the workspace's statuses and a way to clear it. Used in the customer
 * dialog, on the customer page's properties and in the customers list's rows.
 */

import React from 'react';
import { LuCheck } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { customerFieldLabel, customerFieldOf } from '../../lib/customerDisplay';
import type { CustomerFieldRead } from '../../types/Api';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';

/** Props for CustomerStatusPicker. */
export interface CustomerStatusPickerProps {
  /** The status id the customer holds. */
  value: string | null;
  /** The name the customer carries for it, shown until the list catches up. */
  valueName?: string | null;
  /** The workspace's statuses, by position. */
  statuses: readonly CustomerFieldRead[];
  onChange: (statusId: string | null) => void;
  disabled?: boolean;
  /**
   * A bordered chip, a full width row for a properties list, or a borderless
   * cell for a row of the customers list.
   */
  variant?: 'chip' | 'rail' | 'cell';
  className?: string;
}

/** A status or tier's coloured dot, hollow when unset and grey without a colour. */
export const CustomerStatusDot: React.FC<{
  status: CustomerFieldRead | null;
  className?: string;
}> = ({ status, className = '' }) => (
  <span
    aria-hidden="true"
    style={
      status?.color !== null && status?.color !== undefined
        ? { backgroundColor: status.color }
        : undefined
    }
    className={cn(
      'inline-block h-2 w-2 shrink-0 rounded-full',
      status === null
        ? 'border border-text-faint'
        : status.color === null && 'bg-text-faint',
      className
    )}
  />
);

const TRIGGER_CLASS = {
  chip: 'h-7 gap-1.5 rounded-sm border border-line px-2 text-xs enabled:hover:border-line-strong enabled:hover:bg-raised',
  rail: 'min-h-7 w-full justify-start gap-2 rounded-sm px-2 py-1 text-sm enabled:hover:bg-raised',
  cell: 'h-6 min-w-0 max-w-full gap-1.5 rounded-sm px-1 text-xs enabled:hover:bg-raised',
} as const;

/** The chip that sets a customer's status. */
export const CustomerStatusPicker: React.FC<CustomerStatusPickerProps> = ({
  value,
  valueName,
  statuses,
  onChange,
  disabled = false,
  variant = 'chip',
  className = '',
}) => {
  const current = customerFieldOf(statuses, value, valueName);
  return (
    <Menu
      label="Customer status"
      trigger={(trigger) => (
        <button
          type="button"
          aria-label={`Status: ${customerFieldLabel(current, 'No status')}`}
          disabled={disabled}
          className={cn(
            'inline-flex items-center focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default',
            TRIGGER_CLASS[variant],
            variant === 'cell'
              ? current === null
                ? 'text-text-faint'
                : 'text-text-muted'
              : current === null
                ? 'text-text-muted'
                : 'text-text',
            className
          )}
          {...trigger}
        >
          <CustomerStatusDot status={current} />
          <span className="truncate">
            {customerFieldLabel(
              current,
              variant === 'chip'
                ? 'Status'
                : disabled || variant === 'cell'
                  ? 'No status'
                  : 'Set status'
            )}
          </span>
        </button>
      )}
    >
      {statuses.map((status) => (
        <MenuItem
          key={status.id}
          onSelect={() => {
            if (status.id !== value) onChange(status.id);
          }}
        >
          <CustomerStatusDot status={status} />
          <span className="flex-1">{status.name}</span>
          {value === status.id && (
            <LuCheck
              aria-hidden="true"
              className="h-3.5 w-3.5 text-text-muted"
            />
          )}
        </MenuItem>
      ))}
      {current !== null && (
        <>
          {statuses.length > 0 && <MenuSeparator />}
          <MenuItem
            onSelect={() => {
              onChange(null);
            }}
          >
            <CustomerStatusDot status={null} />
            Clear status
          </MenuItem>
        </>
      )}
    </Menu>
  );
};

export default CustomerStatusPicker;
