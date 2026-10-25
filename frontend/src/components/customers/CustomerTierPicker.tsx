/**
 * The customer tier picker: a cell naming the tier, opening a menu of the
 * tiers the workspace's customers already use, a way to clear it, and a way
 * into the customer dialog to type a tier no customer has yet. Used in the
 * customers list's rows, where T opens it on the focused customer.
 */

import React from 'react';
import { LuCheck, LuPencil } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';

/** Props for CustomerTierPicker. */
export interface CustomerTierPickerProps {
  value: string | null;
  /** The tiers offered, in the order they are listed. */
  tiers: string[];
  onChange: (tier: string | null) => void;
  /** Opens somewhere to type a new tier, offered when given. */
  onNewTier?: () => void;
  disabled?: boolean;
  className?: string;
}

/** The tiers a set of customers use, each once, in alphabetical order. */
export const tiersInUse = (
  customers: readonly { tier: string | null }[]
): string[] =>
  [
    ...new Set(
      customers
        .map((customer) => customer.tier)
        .filter((tier): tier is string => tier !== null && tier !== '')
    ),
  ].sort((left, right) => left.localeCompare(right));

/** The cell that sets a customer's tier. */
export const CustomerTierPicker: React.FC<CustomerTierPickerProps> = ({
  value,
  tiers,
  onChange,
  onNewTier,
  disabled = false,
  className = '',
}) => (
  <Menu
    label="Customer tier"
    trigger={(trigger) => (
      <button
        type="button"
        aria-label={`Tier: ${value ?? 'No tier'}`}
        disabled={disabled}
        className={cn(
          'inline-flex h-6 max-w-full min-w-0 items-center rounded-sm px-1 text-xs focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none enabled:hover:bg-raised disabled:cursor-default',
          value === null ? 'text-text-faint' : 'text-text-muted',
          className
        )}
        {...trigger}
      >
        <span className="truncate">{value ?? 'No tier'}</span>
      </button>
    )}
  >
    {tiers.map((tier) => (
      <MenuItem
        key={tier}
        onSelect={() => {
          if (tier !== value) onChange(tier);
        }}
      >
        <span className="flex-1">{tier}</span>
        {value === tier && (
          <LuCheck aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
        )}
      </MenuItem>
    ))}
    {(value !== null || onNewTier !== undefined) && tiers.length > 0 && (
      <MenuSeparator />
    )}
    {value !== null && (
      <MenuItem
        onSelect={() => {
          onChange(null);
        }}
      >
        Clear tier
      </MenuItem>
    )}
    {onNewTier !== undefined && (
      <MenuItem onSelect={onNewTier}>
        <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
        New tier
      </MenuItem>
    )}
  </Menu>
);

export default CustomerTierPicker;
