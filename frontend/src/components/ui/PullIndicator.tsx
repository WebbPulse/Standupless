/**
 * The indicator pull to refresh draws at the top of a list: an arrow that
 * follows the finger and turns once a release would refresh, then a spinner
 * while the refresh shows. It takes no room at rest, and under reduced
 * motion the spinner holds still.
 */

import React from 'react';
import { LuArrowDown } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { PULL_THRESHOLD_PX } from '../../hooks/usePullToRefresh';

/** The height the indicator holds while a refresh shows. */
const REFRESHING_HEIGHT_PX = 40;

/** Props for PullIndicator. */
export interface PullIndicatorProps {
  /** How far the indicator is pulled, in pixels. */
  pull: number;
  refreshing: boolean;
}

/** The pull to refresh indicator. */
export const PullIndicator: React.FC<PullIndicatorProps> = ({
  pull,
  refreshing,
}) => {
  if (!refreshing && pull <= 0) return null;
  const ready = pull >= PULL_THRESHOLD_PX;
  return (
    <div
      data-pull-indicator=""
      role="status"
      aria-live="polite"
      className="flex shrink-0 items-end justify-center overflow-hidden pb-2 text-text-muted"
      style={{ height: refreshing ? REFRESHING_HEIGHT_PX : pull }}
    >
      {refreshing ? (
        <>
          <span className="h-4 w-4 rounded-full border-2 border-line-strong border-t-text-muted motion-safe:animate-spin" />
          <span className="sr-only">Refreshing</span>
        </>
      ) : (
        <>
          <LuArrowDown
            aria-hidden="true"
            className={cn(
              'h-4 w-4 motion-safe:transition-transform motion-safe:duration-150',
              ready && 'rotate-180'
            )}
          />
          <span className="sr-only">
            {ready ? 'Release to refresh' : 'Pull to refresh'}
          </span>
        </>
      )}
    </div>
  );
};

export default PullIndicator;
