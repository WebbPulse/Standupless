/**
 * The count beside the Reviews link in the shell: how many pull requests are
 * waiting on the caller's review right now. Pull requests they already
 * approved or sent back for changes are not counted, because nothing waits on
 * them until the author asks again.
 */

import React from 'react';
import { useReviews } from '../../hooks/useSidebarData';

/** Props for ReviewsBadge: the workspace whose reviews are counted. */
export interface ReviewsBadgeProps {
  workspaceId: string;
}

/** The count past which the badge shows "99+". */
const SATURATES_AT = 100;

/** Shows how many pull requests need the caller's review, or nothing when none do. */
export const ReviewsBadge: React.FC<ReviewsBadgeProps> = ({ workspaceId }) => {
  const reviews = useReviews(workspaceId);

  const waiting = reviews?.counts.needs_review ?? 0;
  if (waiting <= 0) return null;

  const shown = waiting >= SATURATES_AT ? '99+' : String(waiting);

  return (
    <span
      aria-label={`${shown} waiting for your review`}
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-raised px-1 text-2xs font-medium text-text-muted tabular-nums"
    >
      {shown}
    </span>
  );
};

export default ReviewsBadge;
