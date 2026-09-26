/**
 * The small red mark a list row or board card shows while any issue blocking
 * this one is still open. The server keeps the count on the issue itself, so a
 * page of rows draws it without asking for any relations.
 */

import React from 'react';
import { LuOctagonAlert } from 'react-icons/lu';
import { cn } from '../../lib/cn';

/** Props for BlockedMarker: the issue's open blocker count. */
export interface BlockedMarkerProps {
  count: number | undefined;
  className?: string;
}

/** How the mark is named to a screen reader and on hover. */
const blockedLabel = (count: number): string =>
  count === 1
    ? 'Blocked by 1 open issue'
    : `Blocked by ${String(count)} open issues`;

/** The blocked mark, or nothing when no open issue blocks this one. */
export const BlockedMarker: React.FC<BlockedMarkerProps> = ({
  count,
  className,
}) => {
  if (count === undefined || count <= 0) return null;
  const label = blockedLabel(count);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex shrink-0 text-danger', className)}
    >
      <LuOctagonAlert aria-hidden="true" className="h-3.5 w-3.5" />
    </span>
  );
};

export default BlockedMarker;
