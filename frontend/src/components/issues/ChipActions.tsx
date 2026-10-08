/**
 * The clickable chips on an issue row or card. A chip for something with a
 * page of its own, a project or a cycle, opens that page; a chip for a value
 * without one, a label or an estimate, narrows the view to that value. Either
 * way the press stays on the chip, so the issue under it does not open, and
 * Enter or Space on a focused chip never reaches the list's own keys.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { Tooltip } from '../ui/tooltip';

/** Keeps a press on the chip from reaching the row or the list's keys. */
const holdKeys = (event: React.KeyboardEvent): void => {
  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
};

/** The hover and focus look every chip action shares. */
export const CHIP_ACTION_CLASS =
  'cursor-pointer transition-colors duration-100 hover:border-line-strong hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent';

/** Props for FilterChipButton: the tooltip, the action and the chip. */
export interface FilterChipButtonProps {
  /** What the chip does, as its tooltip and accessible name. */
  tooltip: string;
  onFilter: () => void;
  children: React.ReactNode;
  className?: string;
  /** Classes for the wrapper, such as a breakpoint that hides the chip. */
  wrapperClassName?: string;
}

/** A chip that narrows the view to its value. */
export const FilterChipButton: React.FC<FilterChipButtonProps> = ({
  tooltip,
  onFilter,
  children,
  className,
  wrapperClassName,
}) => (
  <span className={cn('relative z-10 shrink-0', wrapperClassName)}>
    <Tooltip text={tooltip}>
      <button
        type="button"
        aria-label={tooltip}
        draggable={false}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          onFilter();
        }}
        onKeyDown={holdKeys}
        className={cn(CHIP_ACTION_CLASS, className)}
      >
        {children}
      </button>
    </Tooltip>
  </span>
);

/** Props for NavChipLink: the tooltip, the destination and the chip. */
export interface NavChipLinkProps {
  tooltip: string;
  to: string;
  children: React.ReactNode;
  className?: string;
  wrapperClassName?: string;
}

/** A chip that opens the page of its value. */
export const NavChipLink: React.FC<NavChipLinkProps> = ({
  tooltip,
  to,
  children,
  className,
  wrapperClassName,
}) => (
  <span className={cn('relative z-10 shrink-0', wrapperClassName)}>
    <Tooltip text={tooltip}>
      <Link
        to={to}
        aria-label={tooltip}
        draggable={false}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={holdKeys}
        className={cn(CHIP_ACTION_CLASS, className)}
      >
        {children}
      </Link>
    </Tooltip>
  </span>
);
