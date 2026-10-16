/**
 * A planning row on an issue, its picker beside a link out to the page the
 * row names. The picker stays the row's main hit target, so changing the
 * project or milestone works as before, and the link is a separate arrow that
 * shows on hover or focus the way Linear's does. It is a real anchor, so a
 * modified or middle click opens the page in a new tab.
 */

import React from 'react';
import { LuArrowUpRight } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import Tooltip from '../ui/tooltip';

/** Props for PlanningRowLink: the picker, where the arrow goes and its name. */
export interface PlanningRowLinkProps {
  /** The page the arrow opens, or null for a row with nothing to open. */
  to: string | null;
  /** The name the arrow is announced and tipped with. */
  label: string;
  children: React.ReactNode;
}

/** A picker with an arrow link to the page its value names. */
export const PlanningRowLink: React.FC<PlanningRowLinkProps> = ({
  to,
  label,
  children,
}) => (
  <div className="group/planning flex min-w-0 items-center gap-0.5">
    <div className="min-w-0 flex-1">{children}</div>
    {to !== null && (
      <Tooltip text={label}>
        <Link
          to={to}
          aria-label={label}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-faint opacity-0 transition-opacity duration-100 group-hover/planning:opacity-100 group-focus-within/planning:opacity-100 hover:bg-raised hover:text-text focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none pointer-coarse:opacity-100"
        >
          <LuArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </Tooltip>
    )}
  </div>
);

export default PlanningRowLink;
