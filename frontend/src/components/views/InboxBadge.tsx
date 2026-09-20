/**
 * The unread count beside the inbox link in the shell. It reads the count route
 * rather than the list, because the badge is on every page and a list read per
 * page would be the most frequent query in the product for a number that fits
 * in one field.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getInboxCount } from '../../api/views';
import { inboxCountKey } from '../../lib/queryKeys';

/** Props for InboxBadge: the workspace whose inbox is counted. */
export interface InboxBadgeProps {
  workspaceId: string;
}

/** How often the badge re-reads, which is the shell's only background poll. */
const POLL_MS = 60000;

/** The count the route saturates at, shown as "99+" past it. */
const SATURATES_AT = 100;

/** Shows the caller's unread notification count, or nothing when it is zero. */
export const InboxBadge: React.FC<InboxBadgeProps> = ({ workspaceId }) => {
  const auth = useQueryAuth();

  const { data } = usePolledQuery(
    ({ signal }) => getInboxCount(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: inboxCountKey(workspaceId),
      auth,
    }
  );

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
