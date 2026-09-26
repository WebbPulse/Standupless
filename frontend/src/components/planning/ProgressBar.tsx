/**
 * The filled bar a rollup's completion reads off. Decorative on its own: every
 * caller puts the same number in words beside it, so a reader who cannot see
 * the bar loses nothing.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for ProgressBar: the whole percent filled, and the track's width. */
export interface ProgressBarProps {
  percent: number;
  className?: string;
}

/** A thin accent bar filled to a percentage. */
export const ProgressBar: React.FC<ProgressBarProps> = ({
  percent,
  className,
}) => (
  <span
    aria-hidden="true"
    className={cn(
      'block h-1.5 overflow-hidden rounded-full bg-accent-soft',
      className
    )}
  >
    <span
      className="block h-full rounded-full bg-accent transition-[width] duration-200"
      style={{ width: `${String(percent)}%` }}
    />
  </span>
);

export default ProgressBar;
