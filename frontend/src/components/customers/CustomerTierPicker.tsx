/**
 * The customer tier picker: a control naming the tier, opening a menu of the
 * tiers a workspace admin set up in settings, a way to clear it, and for an
 * admin a way to the settings page to add one. Used in the customer dialog, on
 * the customer page and in the customers list's rows, where T opens it on the
 * focused customer.
 */

import React from 'react';
import { LuCheck, LuSettings } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { customerFieldLabel, customerFieldOf } from '../../lib/customerDisplay';
import type { CustomerFieldRead } from '../../types/Api';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import { CustomerStatusDot } from './CustomerStatusPicker';

/** Props for CustomerTierPicker. */
export interface CustomerTierPickerProps {
  /** The tier id the customer holds. */
  value: string | null;
  /** The name the customer carries for it, shown until the list catches up. */
  valueName?: string | null;
  /** The workspace's tiers, by position. */
  tiers: readonly CustomerFieldRead[];
  onChange: (tierId: string | null) => void;
  /** Opens the settings page where tiers are added, offered when given. */
  onManage?: () => void;
  disabled?: boolean;
  /** A borderless cell for a list row, a bordered chip, or a full width row. */
  variant?: 'cell' | 'chip' | 'rail';
  className?: string;
}

const TRIGGER_CLASS = {
  chip: 'h-7 gap-1.5 rounded-sm border border-line px-2 text-xs enabled:hover:border-line-strong enabled:hover:bg-raised',
  rail: 'min-h-7 w-full justify-start gap-2 rounded-sm px-2 py-1 text-sm enabled:hover:bg-raised',
  cell: 'h-6 max-w-full min-w-0 gap-1.5 rounded-sm px-1 text-xs enabled:hover:bg-raised',
} as const;

/** The control that sets a customer's tier. */
export const CustomerTierPicker: React.FC<CustomerTierPickerProps> = ({
  value,
  valueName,
  tiers,
  onChange,
  onManage,
  disabled = false,
  variant = 'cell',
  className = '',
}) => {
  const current = customerFieldOf(tiers, value, valueName);
  const label = customerFieldLabel(current, 'No tier');
  return (
    <Menu
      label="Customer tier"
      trigger={(trigger) => (
        <button
          type="button"
          aria-label={`Tier: ${label}`}
          disabled={disabled}
          className={cn(
            'inline-flex items-center focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default',
            TRIGGER_CLASS[variant],
            current === null
              ? variant === 'cell'
                ? 'text-text-faint'
                : 'text-text-muted'
              : variant === 'cell'
                ? 'text-text-muted'
                : 'text-text',
            className
          )}
          {...trigger}
        >
          {variant !== 'cell' && current !== null && (
            <CustomerStatusDot status={current} />
          )}
          <span className="truncate">
            {current === null && variant === 'chip' ? 'Tier' : label}
          </span>
        </button>
      )}
    >
      {tiers.map((tier) => (
        <MenuItem
          key={tier.id}
          onSelect={() => {
            if (tier.id !== value) onChange(tier.id);
          }}
        >
          <CustomerStatusDot status={tier} />
          <span className="flex-1">{tier.name}</span>
          {value === tier.id && (
            <LuCheck
              aria-hidden="true"
              className="h-3.5 w-3.5 text-text-muted"
            />
          )}
        </MenuItem>
      ))}
      {tiers.length === 0 && (
        <MenuItem disabled onSelect={() => undefined}>
          No tiers set up yet
        </MenuItem>
      )}
      {(current !== null || onManage !== undefined) && <MenuSeparator />}
      {current !== null && (
        <MenuItem
          onSelect={() => {
            onChange(null);
          }}
        >
          Clear tier
        </MenuItem>
      )}
      {onManage !== undefined && (
        <MenuItem onSelect={onManage}>
          <LuSettings aria-hidden="true" className="h-3.5 w-3.5" />
          Manage tiers
        </MenuItem>
      )}
    </Menu>
  );
};

export default CustomerTierPicker;
