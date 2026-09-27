/**
 * One collapsible group in the issue rail: a small header that folds the group
 * away, an optional count beside the title, and an optional add button at the
 * end, so every connective section adds from the same place.
 */

import React, { useId, useState } from 'react';
import { LuChevronDown, LuChevronRight, LuPlus } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { IconButton } from '../ui/button';

/** Props for RailSection. */
export interface RailSectionProps {
  title: string;
  /** Shown after the title, such as "2/5" or "3". */
  count?: string;
  /** The add button's name and action. Unset hides the button. */
  add?: { label: string; onClick: () => void };
  /** Extra controls placed before the add button. */
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** A titled rail group that folds away. */
export const RailSection: React.FC<RailSectionProps> = ({
  title,
  count,
  add,
  actions,
  defaultOpen = true,
  children,
  className = '',
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const Chevron = open ? LuChevronDown : LuChevronRight;
  return (
    <section
      aria-label={title}
      className={cn('border-b border-line pb-2', className)}
    >
      <div className="flex h-7 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 py-0.5 text-left text-xs font-medium text-text-faint transition-colors duration-100 hover:text-text"
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <Chevron aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span className="truncate">{title}</span>
          {count !== undefined && (
            <span className="shrink-0 font-normal tabular-nums text-text-faint">
              {count}
            </span>
          )}
        </button>
        {actions}
        {add !== undefined && (
          <IconButton
            label={add.label}
            size="sm"
            className="h-5 w-5 shrink-0"
            onClick={add.onClick}
          >
            <LuPlus className="h-3.5 w-3.5" />
          </IconButton>
        )}
      </div>
      <div id={bodyId} hidden={!open} className="pt-0.5">
        {children}
      </div>
    </section>
  );
};

export default RailSection;
