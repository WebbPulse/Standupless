/**
 * One customer request as a compact row: who asked or what was asked for, the
 * quote beneath when there is one, when it was filed, and a remove action for
 * its author or an admin. Shared by the issue rail, the project overview and
 * the customer page so a request reads the same everywhere.
 */

import React from 'react';
import { LuBuilding2, LuEllipsis, LuTrash2 } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import type { CustomerRequestRead } from '../../types/Api';
import { IconButton } from '../ui/button';
import Menu, { MenuItem } from '../ui/menu';
import RelativeTime from '../ui/relative-time';

/** Props for CustomerRequestRow. */
export interface CustomerRequestRowProps {
  request: CustomerRequestRead;
  /** Where the row's heading links: the customer, or the issue or project. */
  to: string;
  /** The heading: the customer's name, or the issue or project asked for. */
  heading: string;
  /** Extra text after the heading, such as the issue key. */
  detail?: string;
  /** The icon before the heading. */
  icon?: React.ReactNode;
  onRemove: (request: CustomerRequestRead) => void;
  className?: string;
}

/** A request row with its quote and a remove action. */
export const CustomerRequestRow: React.FC<CustomerRequestRowProps> = ({
  request,
  to,
  heading,
  detail,
  icon,
  onRemove,
  className = '',
}) => (
  <li
    className={cn(
      'group/request grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface',
      className
    )}
  >
    <span aria-hidden="true" className="flex h-5 items-center text-text-faint">
      {icon ?? <LuBuilding2 className="h-3.5 w-3.5" />}
    </span>
    <div className="min-w-0">
      <div className="flex h-5 min-w-0 items-center gap-1.5">
        <Link
          to={to}
          className="truncate rounded-xs text-sm text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          {heading}
        </Link>
        {detail !== undefined && detail !== '' && (
          <span className="shrink-0 text-xs text-text-faint tabular-nums">
            {detail}
          </span>
        )}
      </div>
      {request.body !== '' && (
        <blockquote className="mt-0.5 line-clamp-3 border-l-2 border-line pl-2 text-xs whitespace-pre-line text-text-muted">
          {request.body}
        </blockquote>
      )}
    </div>
    <span className="flex h-5 items-center text-xs text-text-faint">
      <RelativeTime value={request.created_at} />
    </span>
    {request.can_delete ? (
      <Menu
        label={`Request from ${request.customer_name} actions`}
        align="end"
        trigger={(trigger) => (
          <IconButton
            label={`Request from ${request.customer_name} actions`}
            size="sm"
            className="h-5 w-5 opacity-0 group-hover/request:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
            {...trigger}
          >
            <LuEllipsis className="h-3.5 w-3.5" />
          </IconButton>
        )}
      >
        <MenuItem
          danger
          onSelect={() => {
            onRemove(request);
          }}
        >
          <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
          Remove request
        </MenuItem>
      </Menu>
    ) : (
      <span />
    )}
  </li>
);

export default CustomerRequestRow;
