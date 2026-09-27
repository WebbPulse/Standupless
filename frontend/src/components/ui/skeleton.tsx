/**
 * Placeholder shapes a list draws while its first read is in flight, so the
 * page settles into its final layout instead of collapsing around a spinner
 * and jumping when the rows land.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for Skeleton: the shape to hold, through the usual class list. */
export interface SkeletonProps {
  className?: string;
}

/**
 * One pulsing bar. Decorative on its own, so it is hidden from assistive
 * technology and the surrounding container carries the spoken label.
 */
export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
  <span
    aria-hidden="true"
    className={cn('block animate-pulse rounded-sm bg-raised', className)}
  />
);

/** Props for SkeletonRows: how many rows to draw and what to call the wait. */
export interface SkeletonRowsProps {
  /** How many placeholder rows to draw. */
  count?: number;
  /** What a screen reader says while these stand in for the rows. */
  label?: string;
  className?: string;
}

/** How many rows fill a list's first screen without overrunning it. */
const DEFAULT_ROWS = 8;

/** The widths the title bar cycles through, so the rows do not read as a grid. */
const TITLE_WIDTHS = ['w-1/3', 'w-1/2', 'w-2/5', 'w-3/5'];

/**
 * A run of placeholder rows at the list row height, matching the leading
 * glyphs, the key, the title and the trailing meta of a real row.
 */
export const SkeletonRows: React.FC<SkeletonRowsProps> = ({
  count = DEFAULT_ROWS,
  label = 'Loading',
  className = '',
}) => (
  <div role="status" aria-busy="true" aria-label={label} className={className}>
    {Array.from({ length: count }, (_, index) => (
      <div
        key={index}
        className="flex h-row items-center gap-2.5 border-b border-line px-4 lg:px-6"
      >
        <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
        <Skeleton className="h-3 w-12 shrink-0 sm:w-16" />
        <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
        <Skeleton
          className={cn('h-3', TITLE_WIDTHS[index % TITLE_WIDTHS.length])}
        />
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Skeleton className="hidden h-3 w-10 sm:block" />
          <Skeleton className="h-5 w-5 rounded-full" />
        </span>
      </div>
    ))}
    <span className="sr-only">{label}</span>
  </div>
);

export default Skeleton;
