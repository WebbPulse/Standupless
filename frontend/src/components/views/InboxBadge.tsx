/**
 * The unread count beside the inbox link in the shell. It reads the count route
 * rather than the list, because the badge is on every page and a list read per
 * page would be the most frequent query in the product for a number that fits
 * in one field. The count is read above the pages, so a navigation keeps the
 * last known number on screen.
 */

import React from 'react';
import { useInboxCount } from '../../hooks/useSidebarData';

/** Props for InboxBadge: the workspace whose inbox is counted. */
export interface InboxBadgeProps {
  workspaceId: string;
}

/** The count the route saturates at, shown as "99+" past it. */
const SATURATES_AT = 100;

/** Shows the caller's unread notification count, or nothing when it is zero. */
export const InboxBadge: React.FC<InboxBadgeProps> = ({ workspaceId }) => {
  const data = useInboxCount(workspaceId);

  const unread = data ?? 0;
  if (unread <= 0) return null;

  const shown = unread >= SATURATES_AT ? '99+' : String(unread);

  return (
    <span
      aria-label={`${shown} unread`}
      className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-2xs font-medium text-on-accent tabular-nums"
    >
      {shown}
    </span>
  );
};

export default InboxBadge;
