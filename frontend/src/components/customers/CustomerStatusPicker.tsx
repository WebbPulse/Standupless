/**
 * The customer status picker: a chip naming the status with its dot, opening a
 * menu of the fixed statuses and a way to clear it. Used in the customer
 * dialog, on the customer page's properties and in the customers list's rows.
 */

import React from 'react';
import { LuCheck } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import {
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_DOT,
  CUSTOMER_STATUS_LABELS,
  customerStatusLabel,
} from '../../lib/customerDisplay';
import type { CustomerStatus } from '../../types/Api';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';

/** Props for CustomerStatusPicker. */
export interface CustomerStatusPickerProps {
  value: CustomerStatus | null;
  onChange: (status: CustomerStatus | null) => void;
  disabled?: boolean;
  /**
   * A bordered chip, a full width row for a properties list, or a borderless
   * cell for a row of the customers list.
   */
  variant?: 'chip' | 'rail' | 'cell';
  className?: string;
}

/** A status's coloured dot, hollow when unset. */
export const CustomerStatusDot: React.FC<{
  status: CustomerStatus | null;
  className?: string;
}> = ({ status, className = '' }) => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-block h-2 w-2 shrink-0 rounded-full',
      status === null
        ? 'border border-text-faint'
        : CUSTOMER_STATUS_DOT[status],
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
  onChange,
  disabled = false,
  variant = 'chip',
  className = '',
}) => (
  <Menu
    label="Customer status"
    trigger={(trigger) => (
      <button
        type="button"
        aria-label={`Status: ${customerStatusLabel(value)}`}
        disabled={disabled}
        className={cn(
          'inline-flex items-center focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default',
          TRIGGER_CLASS[variant],
          variant === 'cell'
            ? value === null
              ? 'text-text-faint'
              : 'text-text-muted'
            : value === null
              ? 'text-text-muted'
              : 'text-text',
          className
        )}
        {...trigger}
      >
        <CustomerStatusDot status={value} />
        <span className="truncate">
          {customerStatusLabel(
            value,
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
    {CUSTOMER_STATUSES.map((status) => (
      <MenuItem
        key={status}
        onSelect={() => {
          onChange(status);
        }}
      >
        <CustomerStatusDot status={status} />
        <span className="flex-1">{CUSTOMER_STATUS_LABELS[status]}</span>
        {value === status && (
          <LuCheck aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
        )}
      </MenuItem>
    ))}
    {value !== null && (
      <>
        <MenuSeparator />
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

export default CustomerStatusPicker;
