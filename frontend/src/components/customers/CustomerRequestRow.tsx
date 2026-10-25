/**
 * One customer request as a compact row: who asked or what was asked for, an
 * important marker when it is flagged, the quote beneath when there is one,
 * when it was filed, and a menu to mark it important, edit it or move it for a
 * writer on its target, and to delete it for its author or an admin. Shared by
 * the issue rail, the project overview and the customer page so a request
 * reads the same everywhere.
 */

import React from 'react';
import {
  LuArrowRight,
  LuBuilding2,
  LuCircleAlert,
  LuEllipsis,
  LuPencil,
  LuTrash2,
} from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import type { CustomerRequestRead } from '../../types/Api';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
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
  /** Flips the important flag. */
  onToggleImportant?: (request: CustomerRequestRead) => void;
  /** Opens the edit dialog. */
  onEdit?: (request: CustomerRequestRead) => void;
  /** Opens the move dialog. */
  onMove?: (request: CustomerRequestRead) => void;
  className?: string;
}

/** A request row with its quote and its actions. */
export const CustomerRequestRow: React.FC<CustomerRequestRowProps> = ({
  request,
  to,
  heading,
  detail,
  icon,
  onRemove,
  onToggleImportant,
  onEdit,
  onMove,
  className = '',
}) => {
  const canEdit = request.can_edit === true;
  const editActions = canEdit
    ? [
        onToggleImportant !== undefined && (
          <MenuItem
            key="important"
            onSelect={() => {
              onToggleImportant(request);
            }}
          >
            <LuCircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
            {request.important === true ? 'Unmark important' : 'Mark important'}
          </MenuItem>
        ),
        onEdit !== undefined && (
          <MenuItem
            key="edit"
            onSelect={() => {
              onEdit(request);
            }}
          >
            <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
            Edit request
          </MenuItem>
        ),
        onMove !== undefined && (
          <MenuItem
            key="move"
            onSelect={() => {
              onMove(request);
            }}
          >
            <LuArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
            Move to issue or project
          </MenuItem>
        ),
      ].filter(Boolean)
    : [];
  const hasMenu = editActions.length > 0 || request.can_delete;
  return (
    <li
      className={cn(
        'group/request grid grid-cols-[1rem_minmax(0,1fr)_auto_auto] items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface',
        className
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-5 items-center text-text-faint"
      >
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
          {request.important === true && (
            <span
              title="Important"
              className="flex shrink-0 items-center gap-0.5 text-xs text-warning"
            >
              <LuCircleAlert aria-hidden="true" className="h-3 w-3" />
              <span className="sr-only">Important</span>
            </span>
          )}
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
      {hasMenu ? (
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
          {editActions}
          {editActions.length > 0 && request.can_delete && <MenuSeparator />}
          {request.can_delete && (
            <MenuItem
              danger
              onSelect={() => {
                onRemove(request);
              }}
            >
              <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete request
            </MenuItem>
          )}
        </Menu>
      ) : (
        <span />
      )}
    </li>
  );
};

export default CustomerRequestRow;
